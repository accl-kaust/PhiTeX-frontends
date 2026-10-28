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
import { coreIndex, coreStore, packs, prefetch, type CoreIndex } from "../../common/src/wasm/host.ts";
import { spawner } from "./thread.ts";

/** The core for the extension at `root`; `folder()`: the project shown, whose document keys are its own. */
export async function startCore(root: string, folder: () => string, log: (s: string) => void): Promise<{ core: Core; session: CoreSession; index: CoreIndex }> {
  const t0 = performance.now();
  // (the core's events and the fetches' reports go to the session's listeners: CoreSession hears the core's)
  let tell: (e: unknown) => void = () => {};
  const core = Core.start(await WebAssembly.compile(await readFile(join(root, "dist/core.wasm"))), {
    spawn: spawner(pathToFileURL(join(root, "dist/thread.js"))),
    fetch: packs((e) => tell(e)),
    async resolve(name) {
      const r = await platform().asset("texmf/" + name).catch(() => null);
      return r?.ok ? { path: name, bytes: new Uint8Array(await r.arrayBuffer()) } : null;
    },
    store: coreStore(folder, async () => core),
    log,
    trap: (tid, error) => log(`core trapped (thread ${tid}): ${error.split("\n")[0]}`),
  });
  const session = new CoreSession(core);
  tell = (e) => session.tell(e);
  const index = await coreIndex();
  core.setIndex(index.tsv, index.release, index.names);
  log(`core started in ${Math.round(performance.now() - t0)} ms`);
  return { core, session, index };
}

export { prefetch };
