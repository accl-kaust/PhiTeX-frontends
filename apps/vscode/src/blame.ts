// Blame in VS Code's preview (phitex/viewer/src/blame.ts draws it): the
// `blame` op answered here, in the extension host, from the folder's git
// history with the git command: `git blame --porcelain` of each text file
// as the editor has it (its unsaved edits, `--contents -`), so the lines
// match the bytes the build read; a figure's image its last commit; the
// tags and branches for "changed since". The same answer as `phitex
// watch`'s (crates/cli/src/blame.rs), with either engine.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parsePorcelain, type BlameCommit, type BlameData, type BlameFile } from "../../../common/src/viewer/blame.ts";
import type { CoreRes } from "../../../common/src/viewer/session.ts";

/** `git ARGS` in `cwd`, `input` on its standard input: its output, or why it failed. */
function git(cwd: string, args: string[], input?: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.stderr.on("data", (b: Buffer) => err.push(b));
    p.on("error", (e) => done({ ok: false, out: "", err: String(e) }));
    p.on("close", (code) => done({ ok: code === 0, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }));
    // (a command that reads no input may end first: its stdin's EPIPE is no failure, its status says)
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

const BINARY = /\.(png|jpe?g|pdf|eps|ps|gif|bmp|tiff?|webp|jbig2|jb2)$/i;

/**
 * The `blame` op: `files` (the project's, from `folder`) blamed
 * (docs/spec-editor-protocol.md §10); `open(path)`: an editor's text of the
 * file at `path` (its unsaved edits), else the disk's is read. No VS Code
 * here: relay.ts gives it the open editors (a test, none).
 */
export async function blame(folder: string, files: string[], open: (path: string) => string | undefined = () => undefined): Promise<CoreRes> {
  const textOf = async (_: string, file: string) => open(join(folder, file)) ?? (await readFile(join(folder, file), "utf8").catch(() => undefined));
  const inside = await git(folder, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { ok: false, error: "no git history here: this folder is not a git repository" };
  const commits: BlameCommit[] = [];
  const at = new Map<string, number>();
  const index = (c: BlameCommit) => {
    let k = at.get(c.id);
    if (k === undefined) (k = commits.push(c) - 1), at.set(c.id, k);
    return k;
  };
  const out: Record<string, BlameFile> = {};
  for (const file of files) {
    if (!file || isAbsolute(file) || file.split(/[\\/]/).includes("..") || out[file]) continue;
    if (BINARY.test(file)) {
      // (an image: its last commit, unless it differs from it now)
      const log = await git(folder, ["log", "-1", "--format=%H%x00%an%x00%ae%x00%at%x00%s", "--", file]);
      if (!log.ok || !log.out.trim()) {
        out[file] = (await readFile(join(folder, file)).then(() => true, () => false)) ? { last: -1 } : { error: "no such file" };
        continue;
      }
      const dirty = !(await git(folder, ["diff", "--quiet", "HEAD", "--", file])).ok;
      const [id, author, email, time, subject] = log.out.trim().split("\0");
      out[file] = { last: dirty ? -1 : index({ id, short: id.slice(0, 7), author, email, time: Number(time), subject }) };
      continue;
    }
    const text = await textOf(folder, file);
    if (text === undefined) {
      out[file] = { error: "no such file" };
      continue;
    }
    const r = await git(folder, ["blame", "--porcelain", "--contents", "-", "--", file], text);
    if (!r.ok) {
      // (a file git does not have yet: all of it not committed)
      out[file] = { text, lines: text.replace(/\n$/, "").split("\n").map(() => -1) };
      continue;
    }
    const p = parsePorcelain(r.out);
    out[file] = { text, lines: p.lines.map((k) => (k < 0 ? -1 : index(p.commits[k]))) };
  }
  const refs = await git(folder, ["for-each-ref", "--format=%(refname:short)%00%(refname)%00%(*committerdate:unix)%00%(committerdate:unix)", "refs/tags", "refs/heads"]);
  const data: BlameData = {
    commits,
    files: out,
    refs: refs.ok
      ? refs.out
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [name, full, peeled, own] = l.split("\0");
            return { name, kind: full.startsWith("refs/tags/") ? "tag" : "branch", time: Number(peeled || own) };
          })
      : [],
    now: Date.now() / 1000,
  };
  return { ok: true, json: data as never };
}
