//! The engine for the frontends: PhiTeX's [`phitex_tex::Build`] as a WASI
//! reactor (wasm32-wasip1-threads). The host (common/src/wasm/) keeps the
//! module's memory shared with one worker per engine thread; its thread 0
//! calls the `ph_*` exports and never blocks, and everything that takes
//! time runs on threads of the module's own:
//!
//! - `ph_open` starts a session thread, which runs the build and tells the
//!   host when it is done (`phitex.event`, JSON);
//! - a file the build lacks is resolved by Shelf's index (`ph_set_index`)
//!   and its pack asked of the host (`phitex.fetch`), or asked by name
//!   (`phitex.want`), by the thread that needs it, which waits until
//!   thread 0 answers (`ph_pack`, `ph_provide`): [`files`].
//!
//! - a `\write18` the engine allows (latexminted) is posted to the host
//!   (`phitex.shell`), which runs it and answers (`ph_shell_done`):
//!   [`shell`], only when the open says the host has a runner.
//!
//! Requests and answers are bytes in the module's memory: the host gets
//! room with `ph_alloc`, and takes an answer's bytes at `ph_output_ptr`,
//! `ph_output_len` (`ph_take_output` hands over the last build's output,
//! `ph_take_prelude` the format's state it made, which the host keeps and
//! gives back with `ph_set_prelude` before a later open).

mod files;
mod shelf;
mod shell;

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
    /// Asks the host for Shelf's pack `id`: it answers with `ph_pack`.
    #[link_name = "fetch"]
    fn host_fetch(id: *const u8, len: usize);
    /// Posts `\write18` call `id` to the host (its frame, shell.rs): it
    /// answers with `ph_shell_done`.
    #[link_name = "shell"]
    fn host_shell(id: u32, frame: *const u8, len: usize);
    /// Tells the host of an event: JSON.
    #[link_name = "event"]
    fn host_event(json: *const u8, len: usize);
}

/// The host, as the files ask it.
struct Host;

impl files::Host for Host {
    fn want(&self, name: &str) {
        // SAFETY: the host reads `len` bytes at `name` before returning.
        unsafe { host_want(name.as_ptr(), name.len()) }
    }

    fn fetch(&self, pack: &str) {
        // SAFETY: as `want`.
        unsafe { host_fetch(pack.as_ptr(), pack.len()) }
    }
}

fn event(v: &Value) {
    let s = v.to_string();
    // SAFETY: as `want`.
    unsafe { host_event(s.as_ptr(), s.len()) }
}

fn shell_hook() -> &'static Arc<shell::Hook> {
    static HOOK: OnceLock<Arc<shell::Hook>> = OnceLock::new();
    HOOK.get_or_init(|| {
        Arc::new(shell::Hook::new(|id, frame| {
            // SAFETY: the host reads the frame before returning.
            unsafe { host_shell(id, frame.as_ptr(), frame.len()) }
        }))
    })
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

/// The layout of the host's `n` bytes (never zero-sized).
fn layout(n: usize) -> std::alloc::Layout {
    std::alloc::Layout::array::<u8>(n.max(1)).expect("a size the host can have")
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_alloc(n: usize) -> *mut u8 {
    // SAFETY: the layout is not zero-sized.
    unsafe { std::alloc::alloc(layout(n)) }
}

#[unsafe(no_mangle)]
pub extern "C" fn ph_free(p: *mut u8, n: usize) {
    // SAFETY: `p` came from `ph_alloc(n)`, the same layout.
    unsafe { std::alloc::dealloc(p, layout(n)) }
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

/// The host's answer to `fetch`: Shelf's pack `id` gunzipped (natively, by
/// the host, off this module), or `ok` 0 (it could not be had).
#[unsafe(no_mangle)]
pub extern "C" fn ph_pack(id: *const u8, id_len: usize, data: *const u8, data_len: usize, ok: i32) {
    let id = String::from_utf8_lossy(bytes(id, id_len)).into_owned();
    files().pack(&id, (ok != 0).then(|| bytes(data, data_len)));
}

/// The host's answer to `\write18` call `id` (its frame, shell.rs).
#[unsafe(no_mangle)]
pub extern "C" fn ph_shell_done(id: u32, frame: *const u8, len: usize) {
    shell_hook().done(id, bytes(frame, len));
}

/// Shelf's index (its TSV, gunzipped) and `release.json`, and the names of
/// the extension's bundled texmf/ (one a line): names are resolved here
/// from now on. 0: done; 1: `release.json` is not JSON.
#[unsafe(no_mangle)]
pub extern "C" fn ph_set_index(
    tsv: *const u8,
    tsv_len: usize,
    release: *const u8,
    release_len: usize,
    bundled: *const u8,
    bundled_len: usize,
) -> i32 {
    let Ok(release) = serde_json::from_slice::<Value>(bytes(release, release_len)) else {
        return 1;
    };
    let index = shelf::Index::new(&String::from_utf8_lossy(bytes(tsv, tsv_len)), &release);
    let names = String::from_utf8_lossy(bytes(bundled, bundled_len))
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    files().set_index(Some(index), names);
    0
}

/// Opens a document: JSON `{main, text, engine?, threads?, ini?, shell?}`
/// (`engine`: pdflatex, the default, or xelatex...; `ini`: the text is
/// the whole job, no format; `shell`: the host runs `\write18`'s allowed
/// commands, else they are refused). Answered at once; the build runs on a
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
    let engine = shelf::engine(req["engine"].as_str().unwrap_or("pdflatex"));
    let shell = req["shell"].as_bool().unwrap_or(false);
    spawn_workers();
    // (the build runs here, as on a native main thread: its stack as large;
    // a stack has no guard page in wasm, an overflow writes over the heap)
    let session = std::thread::Builder::new().stack_size(STACK).spawn(move || {
        let t0 = std::time::Instant::now();
        let f = files().clone();
        let k = files().clone();
        let cached = lock(&PRELUDE).take();
        let had = cached.is_some();
        let opts = Options {
            jobname: main.strip_suffix(".tex").unwrap_or(&main).to_owned(),
            name: format!("./{main}"),
            finder: Arc::new(move |name: &str| f.get(name, engine, &Host)),
            content_key: Some(Arc::new(move |path: &str| k.key(path))),
            threads,
            epoch: Some(0),
            time_limit: None,
            prelude_jobname: "pdflatex".to_owned(),
            prelude_bytes: cached,
            shell_hook: shell.then(|| Arc::clone(shell_hook()) as Arc<dyn phitex_tex::ShellHook>),
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
            "prelude_complete": b.prelude_complete(),
            "prelude_diagnostics": b.prelude_diagnostics().iter().map(|d| format!("{}:{}: {}", d.file, d.line, d.message)).collect::<Vec<_>>(),
            "ms": t0.elapsed().as_secs_f64() * 1000.0,
            "log": log,
        }));
    });
    i32::from(session.is_err()) * 2
}

/// Every thread's stack: a native process's main thread's (wasm has no
/// guard page: an overflow would write over the heap unseen).
const STACK: usize = 8 << 20;

/// The engine's workers are std's threads, which wasi-threads starts as
/// the host's workers (set before the first build; a reactor runs no
/// `main`).
fn spawn_workers() {
    phitex_tex::set_spawn_worker(Box::new(|f| {
        std::thread::Builder::new()
            .stack_size(STACK)
            .spawn(f)
            .expect("a worker thread");
    }));
}

fn main() {}
