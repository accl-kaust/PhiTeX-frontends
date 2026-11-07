// `\write18` for the core (core.ts's `Shell`): latexminted with Pygments
// in Pyodide, PhiTeX's tools/minted-pyodide runner, on thread 0, loaded
// only for a project that uses minted (Pyodide is about 10 MB).
//
// The engine hands each call exactly the files the command may see
// (PhiTeX's docs/note-shell-hook.md): the runner copies in only what
// changed since its last call, so the files of an earlier call that are
// not given this time are removed from its /work first. Calls are run one
// at a time, in the order they came (one Pyodide).

import type { Ran, Shell } from "./core.ts";

export interface Runner {
  system(command: string, files: [string, Uint8Array][]): { status: number; wrote: Map<string, Uint8Array>; removed: string[] };
  pyodide: { FS: any };
}

/** The runner's own loading: createMintedRunner with Pyodide and minted's wheels, as the platform has them. */
export type LoadRunner = () => Promise<Runner>;

const WORK = "/work";

/** A project's sources load minted. */
export function usesMinted(texts: Iterable<string>): boolean {
  for (const t of texts) if (/\\(usepackage|RequirePackage)\s*(\[[^\]]*\])?\s*\{[^}]*\bminted\b/.test(t)) return true;
  return false;
}

/** The `Shell` on the runner `load` gives, loaded at its first call. */
export function mintedShell(load: LoadRunner): Shell {
  let runner: Promise<Runner> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  return (command, files) => {
    const run = async (): Promise<Ran> => {
      let r: Runner;
      try {
        r = await (runner ??= load());
      } catch (e) {
        return { status: 127 << 8, wrote: [], removed: [], why: `minted's runner failed to load: ${e}` };
      }
      return runOn(r, command, files);
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  };
}

/**
 * `command` run on a loaded runner, at once (its Python runs synchronously;
 * only loading Pyodide waits): Firefox's single-threaded core answers its
 * `\write18` inside the call with it.
 */
export function runOn(r: Runner, command: string, files: [string, Uint8Array][]): Ran {
  clear(r.pyodide.FS, new Set(files.map(([n]) => n.replace(/^\.\//, ""))));
  const { status, wrote, removed } = r.system(command, files);
  // (the runner's "not found": a command other than latexminted)
  return { status, wrote: [...wrote], removed, ...(status === 127 << 8 && !wrote.size ? { why: "only latexminted runs here" } : {}) };
}

/** /work holding only the names in `keep` (and the directories they need). */
function clear(FS: any, keep: Set<string>, dir = ""): void {
  const at = dir ? `${WORK}/${dir}` : WORK;
  for (const e of FS.readdir(at) as string[]) {
    if (e === "." || e === "..") continue;
    const rel = dir ? `${dir}/${e}` : e;
    if (FS.isDir(FS.stat(`${WORK}/${rel}`).mode)) clear(FS, keep, rel);
    else if (!keep.has(rel)) FS.unlink(`${WORK}/${rel}`);
  }
}
