// The VS Code extension's builtin engine without VS Code: the core in this
// thread, its threads Node worker threads (core.ts, dist/thread.js), a
// project folder opened through CoreSession as the webview's requests open
// it. Checks the first build settles with pages and a PDF, an edit pushed
// as the editor pushes it settles again with a different PDF, and how long
// each took.
//
//   scripts/build-vscode.sh && scripts/sandbox --net node vscode/dist/smoke.mjs FOLDER [MAIN]

import { readdirSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setPlatform } from "../../common/src/platform.ts";
import { findMain } from "../src/changes.ts";
import { prefetch, startCore } from "../src/core.ts";
import { nodePlatform } from "../src/platform.ts";

const [folder, mainArg] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
setPlatform(nodePlatform(root, mkdtempSync(join(tmpdir(), "phitex-store-"))));

const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tex|sty|cls|bib)$/.test(n)) files[relative(folder, p)] = readFileSync(p, "utf8");
  }
};
walk(folder);
const main = mainArg ?? findMain(files);
if (!main) throw new Error("no main .tex file");

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const { core, session, index } = await startCore(root, () => folder, (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"));
console.log(`core started: ${ms()} ms`);

let settled = 0;
let wake = () => {};
const fetched: string[] = [];
session.onEvent((e: any) => {
  if (e.event === "settled") (settled++, wake());
  if (e.event === "fetching" && !e.failed) fetched.push(e.pack);
});
const next = (n: number) => new Promise<void>((ok, fail) => {
  const timer = setTimeout(() => fail(new Error(`no build settled in 120 s (${settled} settled)`)), 120_000);
  wake = () => settled >= n && (clearTimeout(timer), ok());
});

prefetch(core, index, files, "pdflatex");
const r = await session.request({ op: "open", main, files } as never);
if (!r.ok) throw new Error(`open: ${r.error}`);
await next(1);
const pages = await session.request({ op: "pages" } as never);
const first = core.pdf();
console.log(`first build: ${ms()} ms, ${pages.json?.pages?.length ?? "?"} pages, PDF ${first?.length ?? 0} bytes, packs fetched: ${fetched.length} (${fetched.join(" ")})`);

// (an edit as the editor pushes it: a word after the main file's \begin{document})
const at = files[main].indexOf("\\begin{document}") + "\\begin{document}".length;
const t1 = performance.now();
core.push({ ask: "edit", file: main, start: at, end: at, text: "\nSmoke test words.\n" });
await next(2);
const second = core.pdf();
const changed = !!first && !!second && Buffer.compare(Buffer.from(first), Buffer.from(second)) !== 0;
console.log(`edit: ${Math.round(performance.now() - t1)} ms, PDF ${changed ? "changed" : "UNCHANGED"}`);
const png = await session.request({ op: "png", page: 0 } as never);
console.log(`png: ${png.ok ? "render " + JSON.stringify((png as any).render) : "FAILED " + png.error}`);
core.close();
process.exit(first && changed && png.ok ? 0 : 1);
