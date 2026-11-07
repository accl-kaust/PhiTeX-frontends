// The extension's core worker without eval or a computed import(): in the
// parts esbuild bundled from Pyodide (node_modules/pyodide/), each `eval(`
// and each `import(` of a computed name made a call that throws, as the
// extension's policy (no 'unsafe-eval'; Chrome's worker imports nothing)
// would have it anyway. They are Emscripten's: EM_ASM constants and
// emscripten_run_script for compiled packages, and loadScript for a
// package's JavaScript; minted's wheels are pure Python and use none. The
// stores' linters warn at each one. The counts are checked: a Pyodide with
// more or fewer is looked at again, not passed.
//
//   node tools/build/no-eval.mjs build/overleaf/dist/engine-worker.js

import { readFileSync, writeFileSync } from "node:fs";

const EXPECT = { eval: 6, import: 6 };
const file = process.argv[2];
const src = readFileSync(file, "utf8");
// (esbuild's region comments: "// node_modules/pyodide/pyodide.asm.mjs", "// apps/…")
const parts = src.split(/^(?=\/\/ \S+\.(?:m?js|ts)$)/m);
const seen = { eval: 0, import: 0 };
const out = parts.map((part) => {
  if (!/^\/\/ node_modules\/pyodide\//.test(part)) return part;
  return part
    .replace(/(?<![\w$.])eval\(/g, () => (seen.eval++, "__phitexNoEval("))
    .replace(/(?<![\w$.])import\((?!["'`])/g, () => (seen.import++, "__phitexNoImport("));
});
if (seen.eval !== EXPECT.eval || seen.import !== EXPECT.import) {
  console.error(`no-eval: ${file}: Pyodide's eval ${seen.eval}, import() ${seen.import} (expected ${EXPECT.eval}, ${EXPECT.import}): read the new ones, then update EXPECT`);
  process.exit(1);
}
const stubs =
  'const __phitexNoEval = () => { throw new EvalError("eval is not allowed in this extension"); };\n' +
  'const __phitexNoImport = async (u) => { throw new Error(`import(${u}) is not allowed in this extension`); };\n';
writeFileSync(file, stubs + out.join(""));
console.log(`no-eval: ${file}: Pyodide's ${seen.eval} eval and ${seen.import} import() made to throw`);
