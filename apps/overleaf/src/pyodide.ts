// minted's runner (common/src/wasm/minted.ts): latexminted in Pyodide, from
// the extension's own files (dist/pyodide, dist/minted, minted/'s wheels),
// for both cores' workers (worker.ts, worker1.ts).

import { platform } from "./common/platform.ts";
import type { Runner } from "./common/wasm/minted.ts";

const at = (p: string) => platform().assetUrl(p);

export async function loadMinted(): Promise<Runner> {
  const t0 = performance.now();
  const { loadPyodide } = await import(/* @vite-ignore */ at("dist/pyodide/pyodide.mjs"));
  const { createMintedRunner } = await import(/* @vite-ignore */ at("dist/minted/runner.mjs"));
  const names = (await (await platform().asset("minted/wheels.txt")).text()).split("\n").filter(Boolean);
  // (stdlib and wheels named .data: Edge's store refuses archives in a package)
  const wheels = await Promise.all(names.map(async (n) => [n, new Uint8Array(await (await platform().asset("minted/" + n + ".data")).arrayBuffer())]));
  const r = await createMintedRunner({ loadPyodide, pyodideOptions: { indexURL: at("dist/pyodide/"), stdLibURL: at("dist/pyodide/python_stdlib.data") }, wheels });
  console.info(`[phitex core] minted: Pyodide loaded in ${Math.round(performance.now() - t0)} ms`);
  return r;
}
