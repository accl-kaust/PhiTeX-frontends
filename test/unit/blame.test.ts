// Blame's hosts (the viewer draws it, phitex/viewer/src/blame.ts): VS Code's
// extension host reads git (apps/vscode/src/blame.ts: `git blame
// --porcelain` of the editor's text), Overleaf its project history
// (apps/overleaf/src/blame.ts: the history's diff from the first version,
// the editor's lines it lacks not committed), each answering the `blame` op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blame } from "../../apps/vscode/src/blame.ts";
import { md5, overleafHistory, overleafHue } from "../../apps/overleaf/src/blame.ts";
import { ProjectHistory } from "../../apps/overleaf/src/olhistory.ts";
import type { PageFetch } from "../../apps/overleaf/src/history.ts";
import type { BlameData } from "../../common/src/viewer/blame.ts";
import type { Commit } from "../../common/src/viewer/commits.ts";

const git = (dir: string, who: string, ...args: string[]) =>
  execFileSync("git", ["-c", `user.name=${who}`, "-c", `user.email=${who.toLowerCase()}@example.com`, "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

test("VS Code: each line's commit from git, the editor's unsaved line not committed, an image's last commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phitex-blame-"));
  git(dir, "Alice", "init", "-q");
  writeFileSync(join(dir, "main.tex"), "One.\nTwo.\n");
  writeFileSync(join(dir, "fig.png"), "\x89PNG");
  git(dir, "Alice", "add", "-A");
  git(dir, "Alice", "commit", "-q", "-m", "First draft");
  writeFileSync(join(dir, "main.tex"), "One.\nTwo, by Bob.\n");
  git(dir, "Bob", "commit", "-q", "-am", "Bob's second line");
  git(dir, "Bob", "tag", "v1");
  // (the editor holds a line the disk does not: the build reads the editor's)
  const editor = "One.\nTwo, by Bob.\nThree, unsaved.\n";
  const r = await blame(dir, ["main.tex", "fig.png", "none.tex"], (p) => (p === join(dir, "main.tex") ? editor : undefined));
  assert.ok(r.ok, r.error);
  const d = r.json as unknown as BlameData;
  const who = d.files["main.tex"].lines!.map((k) => (k < 0 ? null : d.commits[k].author));
  assert.deepEqual(who, ["Alice", "Bob", null]);
  assert.equal(d.files["main.tex"].text, editor);
  const bob = d.commits[d.files["main.tex"].lines![1]];
  assert.equal(bob.subject, "Bob's second line");
  assert.equal(bob.email, "bob@example.com");
  assert.equal(d.commits[d.files["fig.png"].last!].author, "Alice");
  assert.ok(d.files["none.tex"].error);
  assert.ok(d.refs!.some((x) => x.name === "v1" && x.kind === "tag"));
  // (not a repository: said)
  const bare = await blame(mkdtempSync(join(tmpdir(), "phitex-nogit-")), ["main.tex"]);
  assert.equal(bare.ok, false);
});

/**
 * A generated history (tools/mock/history-gen.mjs: more than 600 sessions,
 * two people's words inside one line, a deletion, a moved sentence, a
 * spacing-only edit, a session of two people, a label) served as Overleaf
 * serves it, read page by page; `delay` ms an answer.
 */
function generated(sessions = 650): { fetcher: PageFetch; hist: any; text: string; asked: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "phitex-olhist-"));
  execFileSync(process.execPath, [join(import.meta.dirname, "../../tools/mock/history-gen.mjs"), join(dir, "p"), String(sessions)]);
  const hist = JSON.parse(readFileSync(join(dir, "p.history.json"), "utf8"));
  const text = readFileSync(join(dir, "p", "main.tex"), "utf8");
  const asked: string[] = [];
  const upd = (s: any) => ({ fromV: s.fromV, toV: s.toV, meta: { users: s.who.map((w: string) => hist.users[w]), start_ts: s.start, end_ts: s.end }, pathnames: ["main.tex"], labels: hist.labels.filter((l: any) => l.version === s.toV) });
  const fetcher: PageFetch = async (u) => {
    asked.push(u);
    const url = new URL(u, "http://x");
    let body: unknown;
    if (url.pathname.endsWith("/updates")) {
      const before = Number(url.searchParams.get("before") ?? Infinity) || Infinity, min = Number(url.searchParams.get("min_count"));
      const all = hist.sessions.map(upd).reverse().filter((x: any) => x.meta.end_ts < before);
      const page = all.slice(0, min);
      body = { updates: page, ...(all.length > min ? { nextBeforeTimestamp: page.at(-1).meta.end_ts } : {}) };
    } else if (url.pathname.endsWith("/labels")) body = hist.labels.map((l: any) => ({ comment: l.comment, version: l.version, created_at: new Date(l.at).toISOString() }));
    else if (url.pathname.endsWith("/changes")) {
      const since = Number(url.searchParams.get("since"));
      body = { changes: hist.changes.slice(since, since + 100), hasMore: since + 100 < hist.changes.length };
    } else if (/\/blob\//.test(url.pathname)) {
      const b = new TextEncoder().encode(hist.blobs[url.pathname.replace(/.*\//, "")]);
      return { ok: true, status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => b.buffer, text: async () => "", json: async () => null };
    } else throw new Error(`not asked here: ${u}`);
    return { ok: true, status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(0), text: async () => JSON.stringify(body), json: async () => body };
  };
  return { fetcher, hist, text, asked };
}

/** The truth per character: its session ("v42") and author, from the generator's own simulation. */
function truthOf(hist: any): string[] {
  const out: string[] = [];
  for (const [a, b, v] of hist.truth["main.tex"]) {
    const s = hist.sessions.find((x: any) => x.fromV <= v && v < x.toV);
    const u = Object.values(hist.users).find((x: any) => x.id === hist.changes[v].v2Authors[0]) as any;
    for (let i = a; i < b; i++) out.push(`v${s.toV} ${u.first_name} ${u.last_name}`);
  }
  return out;
}

test("Overleaf: blame exact to the character from the first version, no cap: each character's session and author as the history made it", async () => {
  const { fetcher, hist, text, asked } = generated();
  assert.ok(hist.sessions.length > 600);
  const history = new ProjectHistory(() => "/project/p1", fetcher);
  const said: string[] = [];
  history.onProgress((t) => t && said.push(t));
  const { blame: host } = overleafHistory({ history, text: (f) => (f === "main.tex" ? text : undefined), glyphs: async () => [], goto: () => {}, own: undefined, lastVisit: () => null });
  const d = (await host.blame(["main.tex"], { detail: "char", ws: "count", moved: "keep", skip: [] })) as BlameData;
  assert.equal(typeof d, "object", String(d));
  const f = d.files["main.tex"];
  assert.equal(f.text, text);
  const got: string[] = [];
  for (const [a, b, k] of f.runs!) for (let i = a; i < b; i++) got.push(k < 0 ? "none" : `${d.commits[k].short} ${d.commits[k].author}`);
  const want = truthOf(hist);
  assert.equal(got.length, want.length);
  const wrong = got.map((g, i) => (g === want[i] ? -1 : i)).filter((i) => i >= 0);
  assert.equal(wrong.length, 0, `${wrong.length} characters not as the history made them, the first at ${wrong[0]}: ${got[wrong[0]]} for ${want[wrong[0]]}`);
  // (every page of changes read, from the first: no cap)
  assert.ok(asked.some((u) => u.includes("/changes?since=700&paginated=true")), "the changes read past 700");
  assert.ok(said.some((t) => /^Reading history… \d[\d,]* of ~[\d,]+ edits$/.test(t)), said.join(" | "));
  // (the sessions of two people: one commit each person whose characters survive, as the truth names them)
  for (const pair of hist.sessions.filter((s: any) => s.who.length === 2)) {
    const owners = new Set(want.filter((w) => w.startsWith(`v${pair.toV} `)).map((w) => w.split(" ").slice(1).join(" ")));
    const named = new Set(got.filter((w) => w.startsWith(`v${pair.toV} `)).map((w) => w.split(" ").slice(1).join(" ")));
    assert.deepEqual(named, owners, `session v${pair.toV}`);
  }
  assert.ok(hist.sessions.filter((s: any) => s.who.length === 2).some((p: any) => new Set(want.filter((w) => w.startsWith(`v${p.toV} `)).map((w) => w.split(" ")[1])).size === 2), "a session whose two people both still own characters");
});

test("Overleaf: the editor's text ahead of the history is not saved; moved text keeps its writer or is the mover's; a skipped session's text goes to whoever wrote it before; an exact line blame", async () => {
  const { fetcher, hist, text } = generated(450);
  const history = new ProjectHistory(() => "/project/p1", fetcher);
  const typed = text.replace("\\section{Results}\n", "\\section{Results}\nTyped, not saved yet.\n");
  const { blame: host } = overleafHistory({ history, text: () => typed, glyphs: async () => [], goto: () => {}, own: undefined, lastVisit: () => null });
  const opts = { detail: "char" as const, ws: "count" as const, moved: "keep" as const, skip: [] as string[] };
  const d = (await host.blame(["main.tex"], opts)) as BlameData;
  const at = typed.indexOf("Typed, not saved");
  const run = d.files["main.tex"].runs!.find((r) => r[0] <= at && at < r[1])!;
  assert.equal(run[2], -1, "not saved to the history: no writer");
  // (the moved sentence: kept, its first writer's; the mover credited, the mover's)
  const mv = hist.sessions.find((s: any, i: number) => i === 420);
  const mover = Object.values(hist.users).find((u: any) => u.id === hist.changes[mv.fromV].v2Authors[0]) as any;
  const keep = d.commits.filter((c) => c.short === `v${mv.toV}`);
  const credited = (await host.blame(["main.tex"], { ...opts, moved: "mover" })) as BlameData;
  const moverRuns = credited.files["main.tex"].runs!.filter((r) => credited.commits[r[2]]?.short === `v${mv.toV}`);
  const keptRuns = d.files["main.tex"].runs!.filter((r) => d.commits[r[2]]?.short === `v${mv.toV}`);
  const len = (rs: [number, number, number][]) => rs.reduce((n, r) => n + r[1] - r[0], 0);
  assert.ok(len(moverRuns) > len(keptRuns) + 15, `the moved sentence: ${len(keptRuns)} characters the mover's kept, ${len(moverRuns)} credited (${mover.first_name}; ${keep.length})`);
  // (a session skipped: none of the text is its own; its characters the ones it replaced)
  const last = hist.sessions.at(-1);
  const skipped = (await host.blame(["main.tex"], { ...opts, skip: [`v${last.toV}`] })) as BlameData;
  assert.ok(!skipped.files["main.tex"].runs!.some((r) => skipped.commits[r[2]]?.short === `v${last.toV}`), "the skipped session owns nothing");
  assert.ok(d.files["main.tex"].runs!.some((r) => d.commits[r[2]]?.short === `v${last.toV}`), "unskipped, it owns its word");
});

test("Overleaf: the history's sessions as Changes lists them (one lane, \"Lina Chen edited main.tex\", the label a tag); each change's author and time between two versions", async () => {
  const { fetcher, hist, text } = generated(340);
  const history = new ProjectHistory(() => "/project/p1", fetcher);
  const { changes } = overleafHistory({ history, text: () => text, glyphs: async () => [], goto: () => {}, own: undefined, lastVisit: () => 10 });
  // (a page of Overleaf's sessions an ask: the graph shows each as it lands)
  const rows = (await changes.log(0, 200)) as Commit[];
  assert.equal(rows.length, 100);
  assert.match(rows[0].subject, /^(Ali Rahman|Lina Chen|Mary Okafor)(, \w+ \w+)? edited main\.tex$/);
  assert.deepEqual(rows[0].parents, [`v${hist.sessions.at(-1).fromV}`]);
  const label = hist.labels[0];
  const older = (await changes.log(rows.length, 200)) as Commit[];
  if (label) assert.ok([...rows, ...older].some((r) => r.refs.some((x) => x.kind === "tag" && x.name === label.comment)));
  assert.deepEqual(await changes.lastTag!(), label ? { id: `v${label.version}`, name: label.comment } : null);
  assert.ok(older.length > 0 && older[0].id !== rows[0].id);
  // (a word replaced in the last session: its author and time, exactly)
  const s = hist.sessions.at(-1);
  const items = [{ k: 1, kind: "Text" as const, sec: "", old: "x", neu: "y", file: "main.tex", at: 0, end: 0 }];
  const ch = hist.changes[s.fromV].operations[0].textOperation;
  const from = typeof ch[0] === "number" && ch[0] > 0 ? ch[0] : 0;
  const ins = ch.find((x: unknown) => typeof x === "string");
  items[0].at = new TextEncoder().encode(text.slice(0, from)).length;
  items[0].end = items[0].at + new TextEncoder().encode(ins).length;
  await changes.attribute!(items, { from: `v${s.fromV}`, to: `v${s.toV}` }, () => {}, new AbortController().signal);
  const who = Object.values(hist.users).find((u: any) => u.id === hist.changes[s.fromV].v2Authors[0]) as any;
  assert.equal((items[0] as any).who?.name, `${who.first_name} ${who.last_name}`);
  assert.equal((items[0] as any).who?.short, `v${s.toV}`);
});

test("Overleaf's colours: its own hue for a user, by the MD5 of the id", () => {
  const own = "5bf7dab7a18b0b7a1cf6738c";
  assert.equal(overleafHue(own, own), 200);
  assert.equal(overleafHue(undefined, own), 100);
  assert.equal(overleafHue("anonymous-user", own), 100);
  assert.equal(overleafHue("59ad79f46337430b3d37cb9e", own), 146);
  assert.equal(overleafHue("20ad79f46337430b3d37cb9f", own), 323);
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
});
