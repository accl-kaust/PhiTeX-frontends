// minted's runner (common/src/wasm/minted.ts): latexminted in Pyodide, from
// the extension's own files (dist/pyodide, dist/minted, minted/'s wheels),
// for both cores' workers (worker.ts, the demo's; worker1.ts, the extension's).
// The extension's core gives its modules, bundled into its worker: in Chrome
// that worker runs from a blob (engine.ts), where the extension's policy
// (script-src 'self') refuses a blob module and Chrome fetches no extension
// module, so nothing can be imported there at run time. The demo's worker
// imports them as they are.

import { platform } from "./common/platform.ts";
import type { Runner } from "./common/wasm/minted.ts";

const at = (p: string) => platform().assetUrl(p);

/** Pyodide's loader, its module's factory, and the engine's runner. */
export interface MintedModules { loadPyodide: unknown; createPyodideModule: unknown; createMintedRunner: (o: object) => Promise<Runner>; }

/** The modules imported from the package's files, where a worker may import them. */
async function imported(): Promise<MintedModules> {
  const [{ loadPyodide }, { createMintedRunner }, asm] = await Promise.all(["dist/pyodide/pyodide.mjs", "dist/minted/runner.mjs", "dist/pyodide/pyodide.asm.mjs"].map((p) => import(/* @vite-ignore */ at(p))));
  return { loadPyodide, createMintedRunner, createPyodideModule: asm.default };
}

export async function loadMinted(given?: MintedModules): Promise<Runner> {
  const t0 = performance.now();
  const { loadPyodide, createMintedRunner, createPyodideModule } = given ?? (await imported());
  const names = (await (await platform().asset("minted/wheels.txt")).text()).split("\n").filter(Boolean);
  // (stdlib and wheels named .data: Edge's store refuses archives in a package)
  const wheels = await Promise.all(names.map(async (n) => [n, new Uint8Array(await (await platform().asset("minted/" + n + ".data")).arrayBuffer())]));
  const r = await createMintedRunner({ loadPyodide, pyodideOptions: { indexURL: at("dist/pyodide/"), stdLibURL: at("dist/pyodide/python_stdlib.data"), createPyodideModule }, wheels });
  console.info(`[phitex core] minted: Pyodide loaded in ${Math.round(performance.now() - t0)} ms`);
  return r;
}
