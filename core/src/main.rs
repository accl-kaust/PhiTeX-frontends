//! The engine for the frontends: PhiTeX's live document (phitex-live's
//! [`Document`]: the session `phitex watch` keeps, its viewer's protocol,
//! the editor's buffers) as a WASI reactor (wasm32-wasip1-threads), so VS
//! Code's builtin engine and the Overleaf extension run the same session
//! and protocol as native `phitex watch`. The host (common/src/wasm/)
//! keeps the module's memory shared with one worker per engine thread;
//! its thread 0 calls the `ph_*` exports and never blocks, and everything
//! that takes time runs on threads of the module's own:
//!
//! - `ph_open` starts a session thread, which owns the document: it
//!   steps it (the first step is the cold build; a later one builds what
//!   the editor changed), posts its events to the host (`phitex.event`,
//!   JSON: the viewer's `preparing`, `diagnostics`, `origins`, `settled`,
//!   ..., as they happen, and the build's `build` or `failed` after it),
//!   then waits until something is asked. Idle for a while, it stores the
//!   records the builds changed and writes the log (`{event: "idle"}`).
//! - A viewer's request (`ph_request`, `session.ts`'s `CoreReq`) is
//!   answered at once on thread 0 by the document's viewer, from its state
//!   (each lock held for a copy, never across a build); what it asks of the
//!   document (`set_file`, `edit`, `rebuild`) is queued and wakes the
//!   session thread. The editor's other changes (a buffer closed, the
//!   cursor) are pushed the same way (`ph_push`).
//! - A file the build lacks is resolved by Shelf's index (`ph_set_index`)
//!   and its pack asked of the host (`phitex.fetch`), or asked by name
//!   (`phitex.want`), by the thread that needs it, which waits until
//!   thread 0 answers (`ph_pack`, `ph_provide`): [`files`].
//! - What the session keeps between sessions (the format's evaluated
//!   state, the records) is the host's store, asked the same way
//!   (`phitex.store_get`, answered by `ph_stored`) and put without a wait
//!   (`phitex.store_put`): [`store`].
//! - A `\write18` the engine allows (latexminted) is posted to the host
//!   (`phitex.shell`), which runs it and answers (`ph_shell_done`):
//!   [`shell`], only when the open says the host has a runner.
//! - The outputs stay here ([`live::Memory`]): the host reads the main one
//!   (`ph_main_output`), the PDF the viewer is shown (`ph_pdf`) or any
//!   file the build wrote (`ph_file`).
//!
//! Requests and answers are bytes in the module's memory: the host gets
//! room with `ph_alloc`, and takes an answer's bytes at `ph_output_ptr`,
//! `ph_output_len`.

mod files;
mod live;
mod shelf;
mod shell;
mod store;

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use phitex_live::document::Document;
use phitex_live::session::{Job, Session, Status};
use phitex_live::view::{Ask, Viewer};
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
    /// Asks the host for the bytes it stored under `key`: it answers with
    /// `ph_stored`.
    #[link_name = "store_get"]
    fn host_store_get(key: *const u8, len: usize);
    /// Gives the host bytes to store under `key` (it copies them before
    /// returning).
    #[link_name = "store_put"]
    fn host_store_put(key: *const u8, key_len: usize, data: *const u8, data_len: usize);
    /// Tells the host of an event: JSON.
    #[link_name = "event"]
    fn host_event(json: *const u8, len: usize);
}

/// The host, as the files ask it.
struct Asks;

impl files::Host for Asks {
    fn want(&self, name: &str) {
        // SAFETY: the host reads `len` bytes at `name` before returning.
        unsafe { host_want(name.as_ptr(), name.len()) }
    }

    fn fetch(&self, pack: &str) {
        // SAFETY: as `want`.
        unsafe { host_fetch(pack.as_ptr(), pack.len()) }
    }
}

static ASKS: Asks = Asks;

fn event_text(s: &str) {
    // SAFETY: as `want`.
    unsafe { host_event(s.as_ptr(), s.len()) }
}

fn event(v: &Value) {
    event_text(&v.to_string());
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

fn kept() -> &'static Arc<store::Kept> {
    static KEPT: OnceLock<Arc<store::Kept>> = OnceLock::new();
    KEPT.get_or_init(|| {
        Arc::new(store::Kept::new(
            // SAFETY (both): the host reads the bytes before returning.
            |key| unsafe { host_store_get(key.as_ptr(), key.len()) },
            |key, b| unsafe { host_store_put(key.as_ptr(), key.len(), b.as_ptr(), b.len()) },
        ))
    })
}

/// The bytes the last answer left for the host.
static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// The last build's main output: its extension and bytes.
type Output = Mutex<Option<(&'static str, Arc<Vec<u8>>)>>;

/// The open document, as thread 0 reaches it: its viewer (requests
/// answered, asks queued), its outputs, and its session thread's wake.
struct Open {
    viewer: Arc<Viewer>,
    sink: Arc<live::Memory>,
    wake: Arc<Wake>,
    output: Arc<Output>,
}

static OPEN: Mutex<Option<Open>> = Mutex::new(None);

/// What wakes the session thread: something asked (`.0`), or the
/// document closed (`.1`).
#[derive(Default)]
struct Wake {
    state: Mutex<(bool, bool)>,
    cv: Condvar,
}

impl Wake {
    fn set(&self, closed: bool) {
        let mut s = lock(&self.state);
        if closed {
            s.1 = true;
        } else {
            s.0 = true;
        }
        drop(s);
        self.cv.notify_all();
    }
}

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

fn text(p: *const u8, n: usize) -> String {
    String::from_utf8_lossy(bytes(p, n)).into_owned()
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
    let file = (found != 0).then(|| (text(path, path_len), bytes(data, data_len).to_vec()));
    files().provide(&text(name, name_len), file);
}

/// The host's answer to `fetch`: Shelf's pack `id` gunzipped (natively, by
/// the host, off this module), or `ok` 0 (it could not be had).
#[unsafe(no_mangle)]
pub extern "C" fn ph_pack(id: *const u8, id_len: usize, data: *const u8, data_len: usize, ok: i32) {
    files().pack(&text(id, id_len), (ok != 0).then(|| bytes(data, data_len)));
}

/// The host's answer to `store_get`: the bytes it stored under `key`, or
/// `found` 0 (none).
#[unsafe(no_mangle)]
pub extern "C" fn ph_stored(key: *const u8, key_len: usize, data: *const u8, data_len: usize, found: i32) {
    kept().stored(&text(key, key_len), (found != 0).then(|| bytes(data, data_len)));
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
    let names = text(bundled, bundled_len)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect();
    files().set_index(Some(index), names);
    0
}

/// Opens a document: JSON `{main, text, engine?, threads?, ini?, shell?}`
/// (`text`: the main file's text, as an editor holds it; `engine`: the
/// program, pdflatex by default, latex, xelatex, pdftex, tex...; `ini`:
/// the text is the whole job, no format; `shell`: the host runs
/// `\write18`'s allowed commands, else they are refused). The project's
/// other files are given before (`ph_provide`). Answered at once (0; 1:
/// not JSON; 2: no session thread; 3: an engine not known, why in the
/// answer's bytes); the session thread builds and tells its events. A
/// document open before is closed.
#[unsafe(no_mangle)]
pub extern "C" fn ph_open(p: *const u8, n: usize) -> i32 {
    let Ok(req) = serde_json::from_slice::<Value>(bytes(p, n)) else {
        return 1;
    };
    let main = req["main"].as_str().unwrap_or("main.tex").to_owned();
    let body = req["text"].as_str().unwrap_or("");
    let threads = req["threads"].as_u64().and_then(|t| usize::try_from(t).ok());
    let ini = req["ini"].as_bool().unwrap_or(false);
    let engine = match phitex_live::tex::engine(req["engine"].as_str().unwrap_or("pdflatex")) {
        Ok(e) => e,
        Err(e) => {
            *lock(&OUTPUT) = e.into_bytes();
            return 3;
        }
    };
    let shell = req["shell"].as_bool().unwrap_or(false);
    ph_close();
    spawn_workers();
    // (the main file is the project's too: what the editor's edits apply
    // to before it has a buffer, and a double-click's source)
    files().provide(&main, Some((format!("./{main}"), body.as_bytes().to_vec())));
    let host = Arc::new(live::Shelf {
        files: files().clone(),
        engine: shelf::engine(engine.name),
        asks: &ASKS,
        shell: shell.then(|| Arc::clone(shell_hook()) as Arc<dyn phitex_tex::ShellHook>),
    });
    let sink = Arc::new(live::Memory::default());
    let job = Job {
        engine,
        ini,
        etex: engine.etex,
        file: main.clone(),
        path: PathBuf::from(&main),
        jobname: main.strip_suffix(".tex").unwrap_or(&main).to_owned(),
        out_dir: PathBuf::from("."),
        threads,
        spec: None,
        wait_long: true,
        node_records: false,
        synctex: false,
        // (the viewer's `origins`: a double-click's source, forward search)
        origins: true,
        recorder: false,
        shell_escape: false,
        // (as SOURCE_DATE_EPOCH=0: the same bytes every build)
        pdf_date: 0,
        // (the files read back, .aux and .toc, to their fixpoint, as the
        // watch runs them)
        fixpoint: true,
        cache_limit: None,
        edit_diagnostics: true,
    };
    let mut session = Session::new(
        job,
        Arc::from(phitex_live::watch::tex_text(body)),
        host,
        Some(kept().clone() as Arc<dyn phitex_live::host::Store>),
        sink.clone(),
        Arc::new(Status::default()),
    );
    // (as the watch's: no log laid out after each build, written when idle)
    session.watching = true;
    let doc = Document::new(session, &main);
    let viewer = doc.viewer().clone();
    // (the viewer's events to the host as they happen, not at the step's
    // end: `preparing` while the build runs)
    viewer.on_emit(Box::new(event_text));
    let wake = Arc::new(Wake::default());
    let w = wake.clone();
    viewer.on_ask(Box::new(move || w.set(false)));
    viewer.on_read(Box::new(|name| files().read(name).map(|b| b.to_vec())));
    viewer.on_goto(Box::new(|file, line, col, place| {
        event(&json!({"event": "goto", "file": file, "line": line, "col": col, "place": place}));
    }));
    let output = Arc::new(Output::default());
    let (w, o) = (wake.clone(), output.clone());
    // (the document runs here, as on a native main thread: its stack as
    // large; a stack has no guard page in wasm, an overflow writes over
    // the heap)
    let started = std::thread::Builder::new()
        .stack_size(STACK)
        .spawn(move || run(doc, &w, &o));
    if started.is_err() {
        return 2;
    }
    *lock(&OPEN) = Some(Open {
        viewer,
        sink,
        wake,
        output,
    });
    0
}

/// How long the session waits with nothing asked before it is idle (the
/// watch's 2 s).
const IDLE: Duration = Duration::from_secs(2);

/// The session thread: the document stepped whenever something is asked,
/// its events to the host, until it is closed.
fn run(mut doc: Document, wake: &Wake, output: &Output) {
    let mut idle = true;
    loop {
        let events = doc.step();
        if events.iter().any(|e| e["event"] == "build" || e["event"] == "failed") {
            *lock(output) = doc.output();
            idle = false;
        }
        for e in &events {
            event(e);
        }
        let mut s = lock(&wake.state);
        loop {
            if s.1 {
                return;
            }
            if s.0 {
                s.0 = false;
                break;
            }
            if idle {
                s = wake.cv.wait(s).unwrap_or_else(PoisonError::into_inner);
                continue;
            }
            let (g, t) = wake.cv.wait_timeout(s, IDLE).unwrap_or_else(PoisonError::into_inner);
            s = g;
            if t.timed_out() && !s.0 && !s.1 {
                drop(s);
                // (the records the builds changed stored, the log written)
                doc.idle();
                let log = doc.session().write_log();
                let name = format!("{}.log", doc.session().job.jobname);
                event(&json!({"event": "idle", "log": name, "error": log.err()}));
                idle = true;
                s = lock(&wake.state);
            }
        }
    }
}

/// The open document closed: its session thread ends after the step it
/// is in (a build runs to its end).
#[unsafe(no_mangle)]
pub extern "C" fn ph_close() {
    if let Some(o) = lock(&OPEN).take() {
        o.wake.set(true);
    }
}

/// A viewer's request (JSON, `{"id","op",...}`), answered: the reply
/// (`{"id","ok","json"|"error"}`) in the answer's bytes. 0: answered; 1:
/// not JSON; 2: no document open.
#[unsafe(no_mangle)]
pub extern "C" fn ph_request(p: *const u8, n: usize) -> i32 {
    let Ok(req) = serde_json::from_slice::<Value>(bytes(p, n)) else {
        return 1;
    };
    let Some(viewer) = lock(&OPEN).as_ref().map(|o| o.viewer.clone()) else {
        return 2;
    };
    *lock(&OUTPUT) = viewer.answer(&req).into_bytes();
    0
}

/// An editor's change pushed (JSON): `{ask: "set_file", file, text}`,
/// `{ask: "edit", file, start, end, text}` (UTF-16 offsets), `{ask:
/// "closed", file}`, `{ask: "cursor", file, line, col}` (from 0, the
/// column in UTF-16), `{ask: "rebuild"}`. 0: pushed; 1: not one; 2: no
/// document open.
#[unsafe(no_mangle)]
pub extern "C" fn ph_push(p: *const u8, n: usize) -> i32 {
    let Ok(v) = serde_json::from_slice::<Value>(bytes(p, n)) else {
        return 1;
    };
    let s = |k: &str| v[k].as_str().unwrap_or("").to_owned();
    let u = |k: &str| v[k].as_u64().and_then(|x| usize::try_from(x).ok()).unwrap_or(0);
    let a = match v["ask"].as_str() {
        Some("set_file") => Ask::SetFile {
            file: s("file"),
            text: s("text"),
        },
        Some("edit") => Ask::Edit {
            file: s("file"),
            start: u("start"),
            end: u("end"),
            text: s("text"),
        },
        Some("closed") => Ask::Closed { file: s("file") },
        Some("cursor") => Ask::Cursor {
            file: s("file"),
            line: u("line"),
            col: u("col"),
        },
        Some("rebuild") => Ask::Rebuild,
        _ => return 1,
    };
    let Some(viewer) = lock(&OPEN).as_ref().map(|o| o.viewer.clone()) else {
        return 2;
    };
    viewer.push(a);
    0
}

/// The last build's main output in the answer's bytes: 1 a PDF, 2 a DVI,
/// 0 none (no build in, no pages).
#[unsafe(no_mangle)]
pub extern "C" fn ph_main_output() -> i32 {
    let out = lock(&OPEN).as_ref().and_then(|o| lock(&o.output).clone());
    let Some((ext, b)) = out else {
        lock(&OUTPUT).clear();
        return 0;
    };
    *lock(&OUTPUT) = b.to_vec();
    if ext == "pdf" { 1 } else { 2 }
}

/// The PDF the viewer is shown (`doc.pdf`: the last build's; a DVI's only
/// where it was made one, not here yet) in the answer's bytes: 1, or 0
/// (none).
#[unsafe(no_mangle)]
pub extern "C" fn ph_pdf() -> i32 {
    let pdf = lock(&OPEN).as_ref().and_then(|o| o.viewer.pdf());
    let found = pdf.is_some();
    *lock(&OUTPUT) = pdf.map(|b| b.to_vec()).unwrap_or_default();
    i32::from(found)
}

/// A file the build wrote (`name`: `doc.aux`, `doc.log` once idle, the
/// main output) in the answer's bytes: 1, or 0 (not written).
#[unsafe(no_mangle)]
pub extern "C" fn ph_file(p: *const u8, n: usize) -> i32 {
    let f = lock(&OPEN).as_ref().and_then(|o| o.sink.file(&text(p, n)));
    let found = f.is_some();
    *lock(&OUTPUT) = f.map(|b| b.to_vec()).unwrap_or_default();
    i32::from(found)
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
