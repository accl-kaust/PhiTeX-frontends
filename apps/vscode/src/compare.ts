// The preview's asks that need the extension host (webview.ts): Changes'
// Diff (viewer/src/compare.ts runs it in the webview, its history and the
// versions' files read by relay.ts's `vsc-log` and `vsc-files` from the
// folder's git) gets the files as they are and each edit (`cmp-texts`),
// latexdiff run here (the diff wasm, the `latexdiff` op), and the
// marked-up document built by a second core (requests and events on
// channel 2): another instance of the compiled core (core.ts keeps the
// module), its records apart from the editor's, its first build started
// from the editor's persisted graph (the marked-up text opened as the
// editor's main file, compare.ts: the editor's job), an edit of the
// editor's build where that graph is kept; and the panel's View log (an editor tab), Clear
// cache (phitex.caches) and a diff's file saved.

import * as vscode from "vscode";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startCore } from "./core.ts";
import { loadDiff, type DiffReq, type DiffReply } from "../../../common/src/viewer/diff.ts";
import type { GraphStore } from "../../../common/src/wasm/graphs.ts";
import type { CoreRes } from "../../../common/src/viewer/session.ts";
import type { Down, Up } from "./webview.ts";

/** The extension's root, for the diff wasm (dist/diff.wasm); set by compareHost. */
let root = "";
let diffRun: Promise<(r: DiffReq) => DiffReply> | undefined;

/** The `latexdiff` op, answered here as Overleaf's offscreen page answers it. */
export async function latexdiff(req: DiffReq): Promise<CoreRes> {
  if (!root) return { ok: false, error: "latexdiff: not available with this engine" };
  diffRun ??= readFile(join(root, "dist/diff.wasm")).then((b) => loadDiff(b));
  try {
    return { ok: true, json: (await diffRun)(req) } as never;
  } catch (e) {
    return { ok: false, error: `latexdiff: ${e}` };
  }
}

export interface CompareProject {
  /** The extension's root. */
  root: string;
  folder: string;
  main: string;
  /** The project's text files, by path from the folder. */
  files: string[];
  /** Its binary files (figures), given to the second core as to the first. */
  binaries: Record<string, Uint8Array>;
  /** Where the editor's core keeps the document's persisted graph (the builtin engine's), read by the second core, never written. */
  graphs?: GraphStore;
  log: (s: string) => void;
}

/** The webview's compare and its other asks of the extension host, for the preview `view` of project `p`. */
export function compareHost(view: vscode.WebviewPanel, p: CompareProject): vscode.Disposable {
  root = p.root;
  const post = (d: Down) => void view.webview.postMessage(d);
  let second: Awaited<ReturnType<typeof startCore>> | undefined;
  let stopEvents: (() => void) | undefined;
  let comparing = false;

  // (the files as they are now: an open editor's buffer, else the disk's)
  const texts = async () => {
    const out: Record<string, string> = {};
    for (const f of p.files) {
      const path = join(p.folder, f);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
      out[f] = open ? open.getText() : await readFile(path, "utf8").catch(() => "");
    }
    return out;
  };
  let again: ReturnType<typeof setTimeout> | undefined;
  const edited = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!comparing || !e.document.uri.fsPath.startsWith(p.folder)) return;
    clearTimeout(again);
    again = setTimeout(async () => post({ t: "texts", main: p.main, files: await texts() }), 300);
  });

  async function open(): Promise<void> {
    try {
      // (its records under a key of their own (the marked-up document is the editor's job, its main
      // file's name); the editor's graph read, none saved: the diff's is not the document's)
      const graphs: GraphStore | undefined = p.graphs && { on: () => p.graphs!.on(), get: (d) => p.graphs!.get(d), put: async () => {}, drop: async () => {} };
      second ??= await startCore(p.root, () => `${p.folder}~diff`, p.log, undefined, undefined, undefined, graphs);
      for (const [file, bytes] of Object.entries(p.binaries)) second.core.provide(file, { path: "./" + file, bytes });
      const s = second.session;
      stopEvents?.();
      stopEvents = s.onEvent((e) => post({ t: "event", e, ch: 2 }));
      post({ t: "cmp-ready" });
    } catch (e) {
      post({ t: "cmp-ready", error: String(e) });
    }
  }

  function close(): void {
    comparing = false;
    stopEvents?.();
    stopEvents = undefined;
    second?.core.close();
    second = undefined;
  }

  async function save(name: string, data: { text?: string; b64?: string }): Promise<void> {
    const at = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(p.folder, name)), title: "PhiTeX: save the diff" });
    if (!at) return;
    await writeFile(at.fsPath, data.b64 !== undefined ? Buffer.from(data.b64, "base64") : (data.text ?? ""));
  }

  const asks = view.webview.onDidReceiveMessage(async (m: Up) => {
    if (m.t === "cmp-open") return void open();
    // (Changes' Diff against the files as they are: them now, and each edit after)
    if (m.t === "cmp-texts") return void ((comparing = true), post({ t: "texts", main: p.main, files: await texts() }));
    if (m.t === "cmp-close") return close();
    if (m.t === "req" && m.ch === 2) {
      const r = second ? await second.session.request(m.op as never).catch((e): CoreRes => ({ ok: false, error: String(e) })) : ({ ok: false, error: "the compare's core is closed" } as CoreRes);
      return post({ t: "res", id: m.id, r, ch: 2 });
    }
    if (m.t === "showlog") {
      const doc = await vscode.workspace.openTextDocument({ content: m.text, language: "log" });
      return void vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: true });
    }
    if (m.t === "cmd") return void vscode.commands.executeCommand(m.cmd, ...(m.args ?? []));
    if (m.t === "save") return void save(m.name, m);
  });
  return { dispose: () => (asks.dispose(), edited.dispose(), close()) };
}
