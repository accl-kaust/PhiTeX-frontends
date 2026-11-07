// The modules worker1.ts bundles for minted (pyodide.ts): Pyodide's
// module factory (the package gives it no types) and PhiTeX's runner
// (tools/minted-pyodide/runner.mjs, by this name in build.sh's esbuild).
declare module "pyodide/pyodide.asm.mjs" {
  const createPyodideModule: unknown;
  export default createPyodideModule;
}
declare module "phitex-minted-runner" {
  import type { Runner } from "./common/wasm/minted.ts";
  export function createMintedRunner(o: object): Promise<Runner>;
}
