//! The reactor's memory, stack and exports (wasm32 only): memory up to
//! 4 GiB, shared with the host's workers (common/src/wasm/ names the same
//! limits), each thread's stack 8 MiB as a native process's, and the
//! `ph_*` functions the host calls (a reactor's binary exports none by
//! itself).

const EXPORTS: [&str; 11] = [
    "ph_alloc",
    "ph_free",
    "ph_open",
    "ph_provide",
    "ph_pack",
    "ph_set_index",
    "ph_output_ptr",
    "ph_output_len",
    "ph_take_output",
    "ph_take_prelude",
    "ph_set_prelude",
];

fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        for a in [
            "--initial-memory=67108864",
            "--max-memory=4294967296",
            "-zstack-size=8388608",
        ] {
            println!("cargo:rustc-link-arg-bins={a}");
        }
        for e in EXPORTS {
            println!("cargo:rustc-link-arg-bins=--export={e}");
        }
    }
}
