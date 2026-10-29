//! The reactor's memory, stack and exports (wasm32 only): memory as large
//! at first as it may ever be (65535 pages, 64 KiB short of 4 GiB, where
//! the allocator's heap end would wrap to 0), so it never grows: growing a
//! shared memory while threads run trips a V8 bug (another thread's
//! memory.copy or memory.fill into the new pages traps). Committed by the
//! system only as it is touched. Shared with the host's workers
//! (common/src/wasm/ names the same size), each thread's stack 8 MiB as a native process's, and the
//! `ph_*` functions the host calls (a reactor's binary exports none by
//! itself).

const EXPORTS: [&str; 18] = [
    "ph_alloc",
    "ph_free",
    "ph_open",
    "ph_close",
    "ph_request",
    "ph_push",
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
    }
}
