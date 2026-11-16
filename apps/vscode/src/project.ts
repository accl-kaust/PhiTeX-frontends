// The builtin engine's project on disk: which of a folder's files the core
// is given (walk, projectFile), and DiskSync, which keeps them given as the
// disk changes after the preview opened: an image saved over, a .bib or an
// \input file edited outside VS Code, a file added or removed. The core
// holds the files it was given (Core.provide) until they are withdrawn
// (Core.withdraw: the name looked up as never given, Shelf's copy found
// again), and the viewer's `changed` names those to read again (PhiTeX's
// spec-editor-protocol §3.1, §4), as `phitex watch` reads what changed on
// disk. No vscode import: the extension feeds it its FileSystemWatcher's
// events, a test node's.

import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { relPath } from "./changes.ts";

/** The project's text files (what the core reads as source), and the binary ones it is given apart. */
export const TEXT = /\.(tex|sty|cls|bib|bst|cfg|def|clo|fd|ltx|bbx|cbx|lbx|dtx|ins|txt|csv|dat|tikz|pgf|bbl)$/i;
/** (fonts too: xelatex finds the project's own first, kpathsea's "." before TeX Live, so its copy wins over Shelf's of the same name) */
export const BINARY = /\.(png|jpe?g|pdf|eps|gif|otf|ttf|ttc|pfb|pfa|afm|tfm|vf)$/i;
/** Folders never read (VCS, build output, dependencies). */
const SKIP = new Set([".git", "node_modules", ".vscode", "out", "build", ".phitex-diff"]);
/** The most files read from a folder (a project, not a home directory). */
const MAX_FILES = 4000;

/** The project's files under `dir`, absolute. */
export async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (TEXT.test(e.name) || BINARY.test(e.name)) out.push(p);
  }
  return out;
}

/** Whether `rel` (a path from the folder, "/"-separated) is in a folder walk() reads. */
function readFolder(rel: string): boolean {
  const dirs = rel.split("/").slice(0, -1);
  return !dirs.some((d) => d.startsWith(".") || SKIP.has(d));
}

/** Whether `rel` is a file of the project, as walk() takes them. */
export function projectFile(rel: string): boolean {
  const name = rel.split("/").pop() ?? "";
  return readFolder(rel) && !SKIP.has(name) && (TEXT.test(name) || BINARY.test(name));
}

/** The PDF of `main`'s job, beside it (Save PDF's default, a pdflatex run's): its output, never its input. */
export const jobPdf = (main: string) => main.replace(/\.tex$/i, "") + ".pdf";

/**
 * How the editor holds a file: "synced", a buffer the core has (the language
 * client's didOpen, its changes sent as typed: the buffer is the core's
 * text, the disk's the host's under it, read when the buffer closes);
 * "unsaved", a buffer with changes the core never hears (a language the
 * client does not sync): the buffer wins, the disk's ignored; none: the
 * disk's is the file.
 */
export type Held = "synced" | "unsaved" | undefined;

/** What CoreFiles tells a core (common/src/wasm/core.ts's Core). */
export interface FileCore {
  provide(name: string, f: { path: string; bytes: Uint8Array }): unknown;
  withdraw(name: string): void;
}

/**
 * The files a core was given (Core.provide), by name: it keeps them across
 * its documents, so a preview opened again (Restart, another folder)
 * withdraws those no longer in its project, else a file removed, or another
 * folder's, was still found. A file removed is withdrawn, never given as
 * absent: absent is "nowhere", and a project's copy of a distribution's
 * file (a local llncs.cls) deleted must find the distribution's again.
 */
export class CoreFiles {
  private names = new Set<string>();
  private core: FileCore;
  constructor(core: FileCore) {
    this.core = core;
  }

  /** A document opened with these files (the open gives its texts itself, the binaries are given here): the rest the core has, withdrawn. */
  open(texts: string[], binaries: Record<string, Uint8Array>): void {
    const now = new Set([...texts, ...Object.keys(binaries)]);
    for (const n of this.names) if (!now.has(n)) this.core.withdraw(n);
    for (const [n, bytes] of Object.entries(binaries)) this.core.provide(n, { path: "./" + n, bytes });
    this.names = now;
  }

  /** File `rel`'s bytes now (null: gone, withdrawn). */
  give(rel: string, bytes: Uint8Array | null): void {
    if (bytes) {
      this.core.provide(rel, { path: "./" + rel, bytes });
      this.names.add(rel);
    } else {
      this.core.withdraw(rel);
      this.names.delete(rel);
    }
  }
}

/** What the core is told of the disk. */
export interface DiskSink {
  /** File `rel` (not the main) has these bytes now; null: it is gone. */
  give(rel: string, bytes: Uint8Array | null): void;
  /** The main file's text on disk now (the session's text, not a file it is given). */
  setMain(text: string): void;
  /** A build of what was given: these files read again, nothing else checked (the viewer's `{op: "changed", files}`). */
  changed(files: string[]): void;
}

export interface DiskSyncOptions {
  folder: string;
  main: string;
  /** The files the core was given at the open, by path from the folder (their bytes, the main's text among them). */
  given: Record<string, Uint8Array | string>;
  held(rel: string): Held;
  sink: DiskSink;
  /** How long a burst of events is waited out (an atomic save's create, rename and delete; FSEvents' coalescing), in ms. */
  quiet?: number;
  log?(s: string): void;
}

const digest = (b: Uint8Array | string) => createHash("sha1").update(b).digest("hex");

/**
 * The folder's changes on disk given to the core: `touched(path)` for each
 * event (a create, change or delete of a file or a folder), and, once
 * they've been quiet for `quiet` ms, each path read as it is now: its bytes
 * given (`give`), or its removal, the main file's text set (`setMain`), and
 * one build of those files (`changed`). A folder's event stands for every file under it. A file
 * whose bytes are the ones last given is not given again (a save of the
 * same bytes, a touch); the job's own PDF never; an unsaved buffer's file
 * not at all. A synced buffer's file is given, but asks no build: the
 * buffer is what the core builds, the language client's.
 */
export class DiskSync {
  private o: DiskSyncOptions;
  /** The digest of what the core was last given of each file. */
  private known = new Map<string, string>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The flush running (the next waits for it: the disk read in order). */
  private running: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(o: DiskSyncOptions) {
    this.o = o;
    for (const [rel, b] of Object.entries(o.given)) this.known.set(rel, digest(b));
  }

  /** An event of the watcher's at `path` (absolute). */
  touched(path: string): void {
    const rel = relPath(this.o.folder, path);
    if (this.disposed || rel === null || !readFolder(rel) || SKIP.has(rel.split("/").pop() ?? "")) return;
    this.pending.add(rel);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.o.quiet ?? 150);
  }

  /** The changes waiting given now; resolved when they (and any flush before) are. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const paths = [...this.pending];
    this.pending.clear();
    this.running = this.running.then(() => this.apply(paths)).catch((e) => this.o.log?.(`disk: ${e}`));
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private async apply(paths: string[]): Promise<void> {
    const { folder, main, held, sink } = this.o;
    // (each path as it is now: a file, a folder's files, or gone with what was under it)
    const now = new Set<string>();
    for (const rel of paths) {
      const at = join(folder, rel);
      const s = await stat(at).catch(() => null);
      // (a folder walk() would not enter: none of its files)
      if (s?.isDirectory()) {
        if (!rel.split("/").pop()?.startsWith(".")) for (const p of await walk(at)) now.add(relPath(folder, p) ?? "");
      } else if (s) now.add(rel);
      else for (const k of this.known.keys()) if (k === rel || k.startsWith(rel + "/")) now.add(k);
    }
    const build: string[] = [];
    const said: string[] = [];
    for (const rel of now) {
      if (this.disposed) return;
      if (!rel || !projectFile(rel) || rel === jobPdf(main)) continue;
      const h = held(rel);
      if (h === "unsaved") continue;
      const bytes = await readFile(join(folder, rel)).then((b) => new Uint8Array(b), () => null);
      const was = this.known.get(rel);
      if (bytes ? was === digest(bytes) : was === undefined) continue;
      if (bytes) this.known.set(rel, digest(bytes));
      else this.known.delete(rel);
      if (this.disposed) return;
      said.push(`${rel}${bytes ? "" : " (removed)"}${h ? " (the editor's buffer builds)" : ""}`);
      if (rel === main) {
        // (a main file removed: its last text stands, as the watch's)
        if (bytes && !h) sink.setMain(new TextDecoder().decode(bytes));
        continue;
      }
      sink.give(rel, bytes);
      if (!h) build.push(rel);
    }
    if (said.length) this.o.log?.(`disk: ${said.join(", ")}`);
    if (build.length && !this.disposed) sink.changed(build);
  }
}
