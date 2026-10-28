//! The engine for the frontends: PhiTeX's [`phitex_tex::Build`] as a WASI
//! reactor (wasm32-wasip1-threads). The host (common/src/wasm/) keeps the
//! module's memory shared with one worker per engine thread; its thread 0
//! calls the `ph_*` exports and never blocks, and everything that takes
//! time runs on threads of the module's own:
//!
//! - `ph_open` starts a session thread, which runs the build and tells the
//!   host when it is done (`phitex.event`, JSON);
//! - a file the build lacks is asked of the host (`phitex.want`) by the
//!   thread that needs it, which waits until thread 0 answers
//!   (`ph_provide`): [`files`].
//!
//! Requests and answers are bytes in the module's memory: the host gets
//! room with `ph_alloc`, and takes an answer's bytes at `ph_output_ptr`,
//! `ph_output_len` (`ph_take_output` hands over the last build's output,
//! `ph_take_prelude` the format's state it made, which the host keeps and
//! gives back with `ph_set_prelude` before a later open).

mod files;

use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use phitex_tex::{Build, Options};
use serde_json::{Value, json};

use files::Files;

#[link(wasm_import_module = "phitex")]
unsafe extern "C" {
    /// Asks the host for the file `name` (UTF-8): it answers with
    /// `ph_provide`, from its thread 0, later.
    #[link_name = "want"]
    fn host_want(name: *const u8, len: usize);
    /// Tells the host of an event: JSON.
    #[link_name = "event"]
    fn host_event(json: *const u8, len: usize);
}

fn want(name: &str) {
    // SAFETY: the host reads `len` bytes at `name` before returning.
    unsafe { host_want(name.as_ptr(), name.len()) }
}

fn event(v: &Value) {
    let s = v.to_string();
    // SAFETY: as `want`.
    unsafe { host_event(s.as_ptr(), s.len()) }
}

fn files() -> &'static Arc<Files> {
    static FILES: OnceLock<Arc<Files>> = OnceLock::new();
    FILES.get_or_init(Arc::default)
}

/// The bytes the last answer left for the host.
static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
/// The last build's output (the PDF or DVI), until the host takes it.
static BUILT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
/// The format's evaluated state: given by the host before an open (from
/// its store), or made by a build that had none, until the host takes it.
static PRELUDE: Mutex<Option<Vec<u8>>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The bytes `p..p + n` of the module's memory, which the host wrote.
fn bytes<'a>(p: *const u8, n: usize) -> &'a [u8] {
    if n == 0 {
        return &[];
    }
    // SAFETY: the host passes a range it got from `ph_alloc` and wrote.
    unsafe { std::slice::from_raw_parts(p, n) }
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_alloc(n: usize) -> *mut u8 {
    let mut v = std::mem::ManuallyDrop::new(Vec::<u8>::with_capacity(n.max(1)));
    v.as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_free(p: *mut u8, n: usize) {
    // SAFETY: `p` came from `ph_alloc(n)`.
    drop(unsafe { Vec::from_raw_parts(p, 0, n.max(1)) });
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_output_ptr() -> *const u8 {
    lock(&OUTPUT).as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_output_len() -> usize {
    lock(&OUTPUT).len()
}

/// The last build's output moved to the answer's bytes.
#[unsafe(no_mangle)]
pub extern "C" fn ph_take_output() {
    *lock(&OUTPUT) = std::mem::take(&mut *lock(&BUILT));
}

/// The format's state a build made (`{event: "built", prelude: n}`) moved
/// to the answer's bytes, for the host's store.
#[unsafe(no_mangle)]
pub extern "C" fn ph_take_prelude() {
    *lock(&OUTPUT) = lock(&PRELUDE).take().unwrap_or_default();
}

/// The format's state from the host's store, for the next open.
#[unsafe(no_mangle)]
pub extern "C" fn ph_set_prelude(p: *const u8, n: usize) {
    *lock(&PRELUDE) = Some(bytes(p, n).to_vec());
}

/// The host's answer to `want`: `found` 0, the file is nowhere; else its
/// path (`path..`, UTF-8) and bytes.
#[unsafe(no_mangle)]
pub extern "C" fn ph_provide(
    name: *const u8,
    name_len: usize,
    path: *const u8,
    path_len: usize,
    data: *const u8,
    data_len: usize,
    found: i32,
) {
    let name = String::from_utf8_lossy(bytes(name, name_len)).into_owned();
    let file = (found != 0).then(|| {
        (
            String::from_utf8_lossy(bytes(path, path_len)).into_owned(),
            bytes(data, data_len).to_vec(),
        )
    });
    files().provide(&name, file);
}

/// Opens a document: JSON `{main, text, threads?, ini?}` (`ini`: the text
/// is the whole job, no format). Answered at once; the build runs on a
/// session thread, which tells `{event: "built", ...}` when it is in.
#[unsafe(no_mangle)]
pub extern "C" fn ph_open(p: *const u8, n: usize) -> i32 {
    let Ok(req) = serde_json::from_slice::<Value>(bytes(p, n)) else {
        return 1;
    };
    let main = req["main"].as_str().unwrap_or("main.tex").to_owned();
    let text: String = req["text"].as_str().unwrap_or("").to_owned();
    let threads = req["threads"].as_u64().and_then(|t| usize::try_from(t).ok());
    let ini = req["ini"].as_bool().unwrap_or(false);
    spawn_workers();
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        let f = files().clone();
        let cached = lock(&PRELUDE).take();
        let had = cached.is_some();
        let opts = Options {
            jobname: main.strip_suffix(".tex").unwrap_or(&main).to_owned(),
            name: format!("./{main}"),
            finder: Arc::new(move |name: &str| f.get(name, want).map(|x| (x.0.clone(), x.1.clone()))),
            threads,
            epoch: Some(0),
            time_limit: None,
            prelude_jobname: "pdflatex".to_owned(),
            prelude_bytes: cached,
            ..Options::default()
        };
        let prelude = (!ini).then(|| "\\input pdflatex.ini\n".to_owned());
        let b = Build::with(opts, prelude.as_deref(), &text);
        let (out, log) = b.output();
        let pages = b.pages().len();
        let len = out.len();
        *lock(&BUILT) = out;
        let made = if had || ini { None } else { b.export_prelude() };
        let prelude = made.as_ref().map_or(0, Vec::len);
        *lock(&PRELUDE) = made;
        event(&json!({
            "event": "built",
            "pages": pages,
            "bytes": len,
            "pdf": b.is_pdf(),
            "prelude": prelude,
            "ms": t0.elapsed().as_secs_f64() * 1000.0,
            "log": log,
        }));
    });
    0
}

/// The engine's workers are std's threads, which wasi-threads starts as
/// the host's workers (set before the first build; a reactor runs no
/// `main`).
fn spawn_workers() {
    phitex_tex::set_spawn_worker(Box::new(|f| {
        std::thread::Builder::new()
            .stack_size(8 << 20)
            .spawn(f)
            .expect("a worker thread");
    }));
}

fn main() {}
