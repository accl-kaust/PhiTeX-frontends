// A core's end leaves nothing (PhiTeX's issue #46): every one of its
// threads returns, every worker the host started for one exits, and the
// Node process then exits by itself, with no process.exit. Each core
// started as the extension starts its builtin engine (src/core.ts), ended
// in each state it can be in when the extension ends it (deactivate, a
// trapped core's Restart):
//   never opened (no thread started);
//   at rest, after its first build settled (its session thread waiting,
//   the engine's kept threads at rest);
//   mid-build, its cold build begun (asks for packs and files waiting for
//   the host, which hears no more of them).
// Then no worker is left, and the process must exit by itself: a timer
// that does not keep it alive fails the test if it has not.
//
//   tools/build/build-vscode.sh && tools/sandbox --net node build/vscode/dist/end.mjs

import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setPlatform } from "../../../common/src/platform.ts";
import { startCore } from "../src/core.ts";
import { nodePlatform } from "../src/platform.ts";
import { liveWorkers, workersGone } from "../src/thread.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
setPlatform(nodePlatform(root, mkdtempSync(join(tmpdir(), "phitex-store-"))));

const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};

/** `p`'s value, or "late" if it has not come within `limit` ms (the timer cleared either way: nothing left behind). */
async function within<T>(p: Promise<T>, limit: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((ok) => (timer = setTimeout(() => ok("late"), limit)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const DOC = ["\\documentclass{article}", "\\usepackage{amsmath}", "\\begin{document}", "A core's end. $a^2 + b^2 = c^2$", "\\end{document}", ""].join("\n");

/** A core, as the extension starts it; `open`: its document opened, and (`settle`) its first build waited for. */
async function core(open: boolean, settle: boolean) {
  const c = await startCore(root, () => "end-test", (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"));
  if (!open) return c;
  let settled!: () => void;
  const done = new Promise<void>((ok) => (settled = ok));
  // (begun: its first progress, the build under way)
  let begun!: () => void;
  const under = new Promise<void>((ok) => (begun = ok));
  c.session.onEvent((e: any) => {
    if (e.event === "settled") settled();
    else begun();
  });
  const r = await c.session.request({ op: "open", main: "main.tex", files: { "main.tex": DOC }, engine: "pdflatex" } as never);
  if (!r.ok) throw new Error(`open: ${r.error}`);
  if (settle && (await within(done, 180_000)) === "late") throw new Error("the first build did not settle");
  if (!settle && (await within(under, 60_000)) === "late") throw new Error("the first build did not begin");
  return c;
}

/** `c` ended: its end resolved, every thread of its returned. */
async function ended(c: Awaited<ReturnType<typeof core>>, what: string) {
  const t = performance.now();
  const r = await within(c.core.end(), 120_000);
  check(r !== "late" && c.core.threadCount === 0, `${what}: every thread returned (${Math.round(performance.now() - t)} ms${r === "late" ? ", NOT within 120 s: " + c.core.threadCount + " left" : ""})`);
}

const never = await core(false, false);
await ended(never, "a core never opened");
const rest = await core(true, true);
check(rest.core.threadCount > 0, `a core at rest after its first build has threads (${rest.core.threadCount})`);
await ended(rest, "a core at rest after its first build");
const mid = await core(true, false);
await ended(mid, "a core mid-build");
// (ended twice: the same end)
check((await within(mid.core.end(), 1000)) !== "late", "an ended core's end again resolves at once");

const gone = await within(workersGone(), 30_000);
check(gone !== "late" && liveWorkers() === 0, `no worker left${gone === "late" ? ` (${liveWorkers()} after 30 s)` : ""}`);

console.log(fails.length ? `${fails.length} FAILED: ${fails.join("; ")}` : `all passed (${ms()} ms); the process now exits by itself`);
process.exitCode = fails.length ? 1 : 0;
// (the process must exit by itself now: if anything of a core is left, it does not, and this,
// which keeps nothing alive, fails the test with what is left)
setTimeout(() => {
  console.log(`FAIL the process did not exit by itself within 30 s; still active: ${process.getActiveResourcesInfo().join(", ")}; workers: ${liveWorkers()}`);
  process.exit(1);
}, 30_000).unref();
