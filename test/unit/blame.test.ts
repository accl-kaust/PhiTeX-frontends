// Blame's hosts (the viewer draws it, phitex/viewer/src/blame.ts): VS Code's
// extension host reads git (apps/vscode/src/blame.ts: `git blame
// --porcelain` of the editor's text), Overleaf its project history
// (apps/overleaf/src/blame.ts: the history's diff from the first version,
// the editor's lines it lacks not committed), each answering the `blame` op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blame } from "../../apps/vscode/src/blame.ts";
import { md5, overleafBlame, overleafHue } from "../../apps/overleaf/src/blame.ts";
import type { BlameData } from "../../common/src/viewer/blame.ts";

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

test("Overleaf: each line's update from the history's diff, an update's author and version, edits not flushed not committed", async () => {
  const now = Date.now();
  const users = { alice: { id: "u-alice", first_name: "Alice", email: "alice@example.org" }, bob: { id: "u-bob", first_name: "Bob", email: "bob@example.org" } };
  const updates = [
    { fromV: 2, toV: 3, meta: { users: [users.alice], start_ts: now - 3600e3, end_ts: now - 3500e3 }, pathnames: ["main.tex"] },
    { fromV: 1, toV: 2, meta: { users: [users.bob], start_ts: now - 5 * 86400e3, end_ts: now - 5 * 86400e3 + 1e3 }, pathnames: ["fig.png"] },
    { fromV: 0, toV: 1, meta: { users: [users.bob], start_ts: now - 30 * 86400e3, end_ts: now - 30 * 86400e3 + 1e3 }, pathnames: ["main.tex"] },
  ];
  const diff = [{ u: "First.\n" }, { i: "Alice's line.\n", meta: updates[0].meta }, { u: "Last.\n" }];
  const asked: string[] = [];
  const fetcher = (async (u: string) => {
    asked.push(String(u));
    const body = /\/updates/.test(String(u)) ? { updates } : /\/labels/.test(String(u)) ? [{ comment: "Submitted", version: 2, created_at: new Date(now - 86400e3).toISOString() }] : { diff };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const compared: [number, string][] = [];
  const host = overleafBlame({
    base: () => "/project/p1",
    fetcher,
    text: (f) => (f === "main.tex" ? "First.\nAlice's line.\nTyped, not flushed.\nLast.\n" : undefined),
    glyphs: async () => [],
    goto: () => {},
    compare: (v, title) => compared.push([v, title]),
    own: "u-alice",
  });
  const d = (await host.blame(["main.tex", "fig.png"])) as BlameData;
  assert.ok(asked.some((u) => u.includes("/diff?pathname=main.tex&from=0&to=3")), asked.join(" "));
  const lines = d.files["main.tex"].lines!.map((k) => (k < 0 ? null : d.commits[k].id));
  assert.deepEqual(lines, ["v0", "v3", null, "v0"]);
  const v3 = d.commits.find((c) => c.id === "v3")!;
  assert.equal(v3.author, "Alice");
  assert.equal(d.commits[d.files["fig.png"].last!].id, "v2");
  assert.deepEqual(d.refs, [{ name: "Submitted", kind: "tag", time: (now - 86400e3) / 1000 }]);
  // (Overleaf's colours: the own user's hue 200; Compare against the update's first version)
  assert.equal(host.color!(v3), "hsl(200, 70%, 50%)");
  assert.equal(overleafHue("u-bob", "u-alice"), overleafHue("u-bob", undefined));
  // (Overleaf's own cases, services/web/test/frontend/shared/utils/colors.test.js)
  const own = "5bf7dab7a18b0b7a1cf6738c";
  assert.equal(overleafHue(own, own), 200);
  assert.equal(overleafHue(undefined, own), 100);
  assert.equal(overleafHue("anonymous-user", own), 100);
  assert.equal(overleafHue("59ad79f46337430b3d37cb9e", own), 146);
  assert.equal(overleafHue("20ad79f46337430b3d37cb9f", own), 323);
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
  host.compare!(v3);
  assert.deepEqual(compared, [[2, "Before v3"]]);
  assert.deepEqual(host.words, { commit: "version", hashes: false });
});
