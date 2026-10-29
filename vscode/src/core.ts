// The builtin engine: the wasm core (core/, phitex-live's Document, common/
// src/wasm/core.ts) in the extension host, its thread 0 this thread (the
// extension host is Node: a wait on the core's locks is allowed here), its
// threads Node worker threads (thread.ts, bundled as dist/thread.js). What
// it asks is answered from this machine: Shelf's packs (shelf.ts's packRaw:
// kept in the package cache, else fetched from Shelf and kept, the viewer
// told), the extension's bundled texmf/ by name, the session's store (the
// platform's keys and values, the document's under its folder, the format
// the extension ships when none is kept): common/src/wasm/host.ts, as the
// browser's. The viewer's requests go to it through CoreSession, as
// `phitex watch`'s go to the watch.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { platform } from "../../common/src/platform.ts";
import { Core, CoreSession } from "../../common/src/wasm/core.ts";
import { coreIndex, coreStore, pack, prefetch, type CoreIndex } from "../../common/src/wasm/host.ts";
import { mintedShell } from "../../common/src/wasm/minted.ts";
import { spawner } from "./thread.ts";

/**
 * `\write18`'s allowed commands (minted's latexminted) in Pyodide, as the
 * Overleaf extension runs them: Pyodide, PhiTeX's runner and TeX Live's
 * wheels, the extension's own (scripts/build-vscode.sh), loaded at the
 * first call.
 */
function shellOf(root: string, log: (s: string) => void) {
  return mintedShell(async () => {
    const t0 = performance.now();
    const at = (p: string) => join(root, p);
    const { loadPyodide } = await import(pathToFileURL(at("dist/pyodide/pyodide.mjs")).href);
    const { createMintedRunner } = await import(pathToFileURL(at("dist/minted/runner.mjs")).href);
    const names = (await readFile(at("minted/wheels.txt"), "utf8")).split("\n").filter(Boolean);
    const wheels = await Promise.all(names.map(async (n) => [n, new Uint8Array(await readFile(at("minted/" + n + ".data")))]));
    // (Node's Pyodide reads its files by path)
    const r = await createMintedRunner({ loadPyodide, pyodideOptions: { indexURL: at("dist/pyodide/"), stdLibURL: at("dist/pyodide/python_stdlib.data") }, wheels });
    log(`minted: Pyodide loaded in ${Math.round(performance.now() - t0)} ms`);
    return r;
  });
}

/** The core for the extension at `root`; `folder()`: the project shown, whose document keys are its own; `trapped`: told when a thread traps (the core is gone). */
export async function startCore(root: string, folder: () => string, log: (s: string) => void, threads?: number, env?: string[], trapped?: (why: string) => void): Promise<{ core: Core; session: CoreSession; index: CoreIndex }> {
  const t0 = performance.now();
  const core = Core.start(await WebAssembly.compile(await readFile(join(root, "dist/core.wasm"))), {
    spawn: spawner(pathToFileURL(join(root, "dist/thread.js"))),
    fetch: pack,
    async resolve(name) {
      const r = await platform().asset("texmf/" + name).catch(() => null);
      return r?.ok ? { path: name, bytes: new Uint8Array(await r.arrayBuffer()) } : null;
    },
    store: coreStore(folder, async () => core),
    shell: shellOf(root, log),
    env,
    log,
    trap: (tid, error) => {
      log(`core trapped (thread ${tid}): ${error.split("\n")[0]}`);
      trapped?.(error.split("\n")[0]);
    },
  });
  // (the engine's threads: the host's to say, wasm has no available_parallelism)
  // (every project may use minted: the runner loads only at its first call)
  const session = new CoreSession(core, threads ? { shell: true, threads } : { shell: true });
  const index = await coreIndex();
  core.setIndex(index.tsv, index.release, index.table, index.names);
  log(`core started in ${Math.round(performance.now() - t0)} ms`);
  return { core, session, index };
}

export { prefetch };
