// minted's runner (common/src/wasm/minted.ts): latexminted in Pyodide, from
// the extension's own files (dist/pyodide, dist/minted, minted/'s wheels),
// for both cores' workers (worker.ts, the demo's; worker1.ts, the extension's).
// In Chrome its modules are imported as blobs: there the extension's core
// runs in a blob worker (engine.ts), where Chrome fetches no extension
// module; elsewhere (Firefox's core, the demo's) as they are.

import { platform } from "./common/platform.ts";
import type { Runner } from "./common/wasm/minted.ts";

const at = (p: string) => platform().assetUrl(p);

/** The worker runs from a blob (engine.ts says the extension's root to it then). */
const inBlob = !!(globalThis as { PHITEX_ROOT?: string }).PHITEX_ROOT;

/** A module of ours, imported as it is, or in a blob worker from a blob of its text (one with no imports of its own). */
async function blobImport(p: string): Promise<any> {
  if (!inBlob) return import(/* @vite-ignore */ at(p));
  const text = await (await platform().asset(p)).text();
  return import(/* @vite-ignore */ URL.createObjectURL(new Blob([text], { type: "text/javascript" })));
}

export async function loadMinted(): Promise<Runner> {
  const t0 = performance.now();
  const [{ loadPyodide }, { createMintedRunner }, asm] = await Promise.all(["dist/pyodide/pyodide.mjs", "dist/minted/runner.mjs", "dist/pyodide/pyodide.asm.mjs"].map(blobImport));
  const names = (await (await platform().asset("minted/wheels.txt")).text()).split("\n").filter(Boolean);
  // (stdlib and wheels named .data: Edge's store refuses archives in a package)
  const wheels = await Promise.all(names.map(async (n) => [n, new Uint8Array(await (await platform().asset("minted/" + n + ".data")).arrayBuffer())]));
  const r = await createMintedRunner({ loadPyodide, pyodideOptions: { indexURL: at("dist/pyodide/"), stdLibURL: at("dist/pyodide/python_stdlib.data"), createPyodideModule: asm.default }, wheels });
  console.info(`[phitex core] minted: Pyodide loaded in ${Math.round(performance.now() - t0)} ms`);
  return r;
}
