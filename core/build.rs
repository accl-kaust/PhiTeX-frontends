//! The reactor's memory, stack and exports (wasm32 only): memory as large
//! at first as it may ever be (65535 pages, 64 KiB short of 4 GiB, where
//! the allocator's heap end would wrap to 0), so it never grows: growing a
//! shared memory while threads run trips a V8 bug (another thread's
//! memory.copy or memory.fill into the new pages traps). Committed by the
//! system only as it is touched. Shared with the host's workers
//! (common/src/wasm/ names the same size), each thread's stack 8 MiB as a native process's, and the
//! `ph_*` functions the host calls (a reactor's binary exports none by
//! itself).
//!
//! The 4 GiB, decided (2026-11-04) and kept: it is a virtual reservation,
//! not memory used. What a build touches is what the process holds: about
//! 1.1 GiB before the text, then the engine's state a page (5 to 8 MiB a
//! page of a dense manual, 1.5 of plain text): 3.1 GiB for the beamer
//! user guide's 241 pages at 4 threads, less than the native engine's 3.7
//! GB (PhiTeX docs/note-browser-memory.md). The allocator loses about 10%
//! to fragmentation (`--features memstats` counts it). A smaller fixed
//! size would cut off documents the native engine builds, and a size
//! that grows is unsafe under
//! threads (above). A 4 GiB reservation needs a 64-bit browser: 32-bit
//! Chrome and Firefox refuse it (the extension's and the web page's
//! single-threaded core, wasm32-wasip1, asks the same of its own
//! memory), and each reservation costs the browser's address space only
//! (V8 reserves its guard regions beside it). Where a browser refuses it
//! the host says so before the first build (scripts/dev/mock-run.mjs,
//! web/test/chrome-probe.mjs): a core that cannot start is told, never
//! silently built with less.

const EXPORTS: [&str; 18] = [
    "ph_alloc",
    "ph_free",
    "ph_open",
    "ph_close",
    "ph_request",
    "ph_lsp",
    "ph_provide",
    "ph_pack",
    "ph_stored",
    "ph_set_index",
    "ph_shell_done",
    "ph_output_ptr",
    "ph_output_len",
    "ph_main_output",
    "ph_pdf",
    "ph_file",
    "ph_strips",
    "ph_frame",
];

fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        for a in [
            "--initial-memory=4294901760",
            "--max-memory=4294901760",
            "-zstack-size=8388608",
        ] {
            println!("cargo:rustc-link-arg-bins={a}");
        }
        for e in EXPORTS {
            println!("cargo:rustc-link-arg-bins=--export={e}");
        }
        if std::env::var_os("CARGO_FEATURE_MEMSTATS").is_some() {
            println!("cargo:rustc-link-arg-bins=--export=ph_mem");
        }
    }
}
