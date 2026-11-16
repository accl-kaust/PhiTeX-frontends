// VS Code's builtin engine and the disk (apps/vscode/src/project.ts,
// DiskSync): what a folder's changes after the preview opened give the
// core. Driven by the paths a watcher would report; the files are real, in
// a temporary folder. apps/vscode/test/disk.ts runs the same on the core.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreFiles, DiskSync, jobPdf, projectFile, type Held } from "../../apps/vscode/src/project.ts";


function setup(held: Record<string, Held> = {}, quiet = 20) {
  const folder = mkdtempSync(join(tmpdir(), "phitex-disk-"));
  const files: Record<string, string | Uint8Array> = {
    "main.tex": "\\documentclass{article}\\begin{document}\\input{part}\\includegraphics{fig}\\end{document}",
    "part.tex": "part",
    "refs.bib": "@book{a, title={A}}",
    "fig.png": new Uint8Array([1, 2, 3]),
    "chap/one.tex": "one",
  };
  for (const [p, b] of Object.entries(files)) {
    mkdirSync(join(folder, p, ".."), { recursive: true });
    writeFileSync(join(folder, p), b);
  }
  const log: string[] = [];
  const sync = new DiskSync({
    folder,
    main: "main.tex",
    given: files,
    held: (rel) => held[rel],
    quiet,
    sink: {
      give: (rel, b) => log.push(`give ${rel} ${b ? new TextDecoder().decode(b) : "null"}`),
      setMain: (t) => log.push(`main ${t}`),
      rebuild: () => log.push("rebuild"),
    },
  });
  const touch = (...ps: string[]) => ps.forEach((p) => sync.touched(join(folder, p)));
  const write = (p: string, b: string) => (mkdirSync(join(folder, p, ".."), { recursive: true }), writeFileSync(join(folder, p), b));
  return { folder, sync, log, touch, write, done: () => (sync.dispose(), rmSync(folder, { recursive: true })) };
}

test("an image saved over in place: its new bytes given, one build", async () => {
  const t = setup();
  t.write("fig.png", "new");
  // (an editor's save: the change heard twice, FSEvents' coalesced or not)
  t.touch("fig.png", "fig.png");
  await t.sync.flush();
  assert.deepEqual(t.log, ["give fig.png new", "rebuild"]);
  t.done();
});

test("an image replaced by a rename (an atomic save): the file given, the temporary one not", async () => {
  const t = setup();
  t.write("fig.png.tmp~", "renamed");
  t.touch("fig.png.tmp~");
  renameSync(join(t.folder, "fig.png.tmp~"), join(t.folder, "fig.png"));
  t.touch("fig.png.tmp~", "fig.png");
  await t.sync.flush();
  assert.deepEqual(t.log, ["give fig.png renamed", "rebuild"]);
  t.done();
});

test("a burst of events waits for the quiet, then builds once", async () => {
  const t = setup({}, 40);
  t.write("refs.bib", "@book{a, title={B}}");
  t.touch("refs.bib");
  t.write("part.tex", "part two");
  t.touch("part.tex");
  t.write("fig.png", "x");
  t.touch("fig.png", "refs.bib");
  assert.deepEqual(t.log, []);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(t.log.slice().sort(), ["give fig.png x", "give part.tex part two", "give refs.bib @book{a, title={B}}", "rebuild"]);
  assert.equal(t.log.at(-1), "rebuild");
  t.done();
});

test("the same bytes saved again: nothing given, no build", async () => {
  const t = setup();
  t.write("part.tex", "part");
  t.touch("part.tex");
  await t.sync.flush();
  assert.deepEqual(t.log, []);
  t.done();
});

test("a file removed, then made again; a folder removed, and one moved in", async () => {
  const t = setup();
  rmSync(join(t.folder, "fig.png"));
  t.touch("fig.png");
  await t.sync.flush();
  assert.deepEqual(t.log.splice(0), ["give fig.png null", "rebuild"]);
  t.write("fig.png", "back");
  t.touch("fig.png");
  await t.sync.flush();
  assert.deepEqual(t.log.splice(0), ["give fig.png back", "rebuild"]);
  // (a folder's delete is one event for its files)
  rmSync(join(t.folder, "chap"), { recursive: true });
  t.touch("chap");
  await t.sync.flush();
  assert.deepEqual(t.log.splice(0), ["give chap/one.tex null", "rebuild"]);
  // (and a folder moved in, one event for the folder)
  mkdirSync(join(t.folder, "..", "moved-" + t.folder.split("/").pop()), { recursive: true });
  const elsewhere = join(t.folder, "..", "moved-" + t.folder.split("/").pop());
  writeFileSync(join(elsewhere, "two.tex"), "two");
  writeFileSync(join(elsewhere, "pic.jpg"), "jpg");
  renameSync(elsewhere, join(t.folder, "figs"));
  t.touch("figs");
  await t.sync.flush();
  assert.deepEqual(t.log.splice(0).sort(), ["give figs/pic.jpg jpg", "give figs/two.tex two", "rebuild"]);
  t.done();
});

test("the main file changed on disk: its text set, no file given", async () => {
  const t = setup();
  t.write("main.tex", "\\documentclass{article}\\begin{document}new\\end{document}");
  t.touch("main.tex");
  await t.sync.flush();
  assert.deepEqual(t.log, ["main \\documentclass{article}\\begin{document}new\\end{document}"]);
  t.done();
});

test("the editor's buffer wins: an unsaved one's file not given; a synced one's given, no build", async () => {
  const t = setup({ "part.tex": "unsaved", "refs.bib": "synced", "main.tex": "synced" });
  t.write("part.tex", "disk");
  t.write("refs.bib", "disk bib");
  t.write("main.tex", "disk main");
  t.touch("part.tex", "refs.bib", "main.tex");
  await t.sync.flush();
  // (the synced one's disk text is what the core reads when its buffer closes)
  assert.deepEqual(t.log, ["give refs.bib disk bib"]);
  t.done();
});

test("outputs and folders the project is not read from: nothing", async () => {
  const t = setup();
  for (const p of ["main.pdf", "main.aux", "main.log", ".git/index", "out/main.pdf", "build/x.png", "node_modules/a/b.tex", ".phitex-diff/main.tex", "notes.md"]) {
    t.write(p, "x");
    t.touch(p);
  }
  await t.sync.flush();
  assert.deepEqual(t.log, []);
  t.done();
});

test("projectFile: what the open's walk reads", () => {
  for (const p of ["main.tex", "a/b/fig.PNG", "refs.bib", "fonts/x.otf", "data/t.csv"]) assert.ok(projectFile(p), p);
  for (const p of ["a.aux", ".git/x.tex", "x/.cache/y.png", "out/a.tex", "node_modules/a.tex", "README.md"]) assert.ok(!projectFile(p), p);
});

test("a core's files across its previews: another open gives what it no longer has as absent", () => {
  const said: string[] = [];
  const f = new CoreFiles((n, x) => said.push(`${n} ${x ? new TextDecoder().decode(x.bytes) : "absent"}`));
  f.open(["main.tex", "a.tex"], { "fig.png": new TextEncoder().encode("1"), "old.png": new TextEncoder().encode("2") });
  assert.deepEqual(said.splice(0), ["fig.png 1", "old.png 2"]);
  f.give("new.pdf", new TextEncoder().encode("3"));
  f.give("old.png", null);
  assert.deepEqual(said.splice(0), ["new.pdf 3", "old.png absent"]);
  // (Restart, the folder as it is now; or another folder's preview)
  f.open(["main.tex"], { "fig.png": new TextEncoder().encode("1") });
  assert.deepEqual(said.splice(0).sort(), ["a.tex absent", "fig.png 1", "new.pdf absent"]);
  assert.equal(jobPdf("src/thesis.tex"), "src/thesis.pdf");
});
