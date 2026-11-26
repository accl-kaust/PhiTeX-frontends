// The native engine's command (the setting phitex.path): which file it is,
// its version, and whether it runs the preview (`phitex watch --lsp`),
// found before anything is started, so that a missing or old phitex is
// said once, in words, with what to do (never the language client's own
// "couldn't create connection" and "write EPIPE"). No vscode import: the
// unit tests run it (test/unit/native.test.ts).

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** What the command is: found and able, or why not. */
export type Native =
  | { ok: true; path: string; version: string }
  | { ok: false; why: "missing"; cmd: string; looked: string }
  | { ok: false; why: "old" | "broken"; cmd: string; path: string; version: string; detail: string };

/** A file that may run. */
const runnable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== "win32") accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The file `cmd` runs: a path (with a separator) as it is, against
 * `cwd`; a bare name, the first match on the PATH (with Windows' PATHEXT),
 * as the system finds it. Null: none.
 */
export function whichCommand(cmd: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), exists: (p: string) => boolean = runnable, win = process.platform === "win32"): string | null {
  if (!cmd) return null;
  const exts = win ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) {
    const p = isAbsolute(cmd) ? cmd : resolve(cwd, cmd);
    return exts.map((e) => p + e).find(exists) ?? null;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(win ? ";" : delimiter)) {
    if (!dir) continue;
    for (const e of exts) if (exists(join(dir, cmd + e))) return join(dir, cmd + e);
  }
  return null;
}

/** The version `--version` says ("phitex 1.0.5-nightly…" → "1.0.5-nightly…"). */
export function versionOf(out: string): string {
  return /phitex\s+(\S+)/i.exec(out)?.[1] ?? (out.trim().split("\n")[0] || "of an unknown version");
}

const run = (file: string, args: string[]) =>
  new Promise<{ code: number | null; out: string }>((done) =>
    execFile(file, args, { timeout: 8000, env: { ...process.env, CI: "" } }, (e, stdout, stderr) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })),
  );

/** Whether `watch --help` lists `--lsp`, what the preview runs. */
export const hasLsp = (help: string) => /--lsp\b/.test(help);

/** Find, run and ask `cmd`: its file, its version, and whether it has `watch --lsp`. */
export async function probeNative(cmd: string, cwd?: string): Promise<Native> {
  const path = whichCommand(cmd, process.env, cwd);
  if (!path) return { ok: false, why: "missing", cmd, looked: /[\\/]/.test(cmd) ? cmd : "the PATH" };
  const v = await run(path, ["--version"]);
  const version = versionOf(v.out);
  if (v.code !== 0) return { ok: false, why: "broken", cmd, path, version, detail: v.out.trim().split("\n").slice(-3).join(" ") };
  const help = await run(path, ["watch", "--help"]);
  // (its help, answered: an old one's error may quote "--lsp" back, so a failed --help is never a yes)
  if (help.code !== 0 || !hasLsp(help.out)) return { ok: false, why: "old", cmd, path, version, detail: help.out.trim().split("\n").slice(-2).join(" ") };
  return { ok: true, path, version };
}

/** The one notification for a phitex that can't run the preview: what is wrong, in words. */
export function nativeProblem(n: Exclude<Native, { ok: true }>): string {
  if (n.why === "missing")
    return n.looked === "the PATH"
      ? `PhiTeX: no "${n.cmd}" command on the PATH, so the native engine (phitex watch) can't start. Install phitex, set phitex.path to where it is, or use the builtin engine (nothing to install).`
      : `PhiTeX: no phitex at ${n.cmd} (the setting phitex.path), so the native engine (phitex watch) can't start. Install phitex, correct phitex.path, or use the builtin engine (nothing to install).`;
  if (n.why === "old") return `PhiTeX: phitex ${n.version} at ${n.path} is too old for the preview: it has no \`watch --lsp\`. Install a newer phitex (1.0 or later), or use the builtin engine.`;
  return `PhiTeX: ${n.path} did not run (\`--version\` failed: ${n.detail || "no output"}). Reinstall phitex, set phitex.path to another one, or use the builtin engine.`;
}

/** Where phitex's install instructions are. */
export const INSTALL_URL = "https://phitex.org/install.html";
