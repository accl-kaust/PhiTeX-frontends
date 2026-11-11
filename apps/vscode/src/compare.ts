// The builtin preview's asks that need the extension host (webview.ts):
// Compare (viewer/src/compare.ts runs it in the webview) gets its version
// from the folder's git history (VS Code's git extension: the log in a
// QuickPick, the version's files by `git show`), latexdiff run here (the
// diff wasm, the `latexdiff` op), and the marked-up document built by a
// second core of its own (requests and events on channel 2); and the
// panel's View log (an editor tab), Clear cache (phitex.caches) and a
// diff's file saved.

import * as vscode from "vscode";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startCore } from "./core.ts";
import { loadDiff, type DiffReq, type DiffReply } from "../../../common/src/viewer/diff.ts";
import type { CoreRes } from "../../../common/src/viewer/session.ts";
import type { Down, Up } from "./webview.ts";

/** What of VS Code's git extension's API (its getAPI(1)) a compare uses. */
interface GitCommit {
  hash: string;
  message: string;
  authorName?: string;
  authorDate?: Date;
}
interface GitRepo {
  log(o?: { maxEntries?: number }): Promise<GitCommit[]>;
  show(ref: string, path: string): Promise<string>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepo | null;
}

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

const ago = (d?: Date) => {
  if (!d) return "";
  const s = (Date.now() - d.getTime()) / 1000;
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

export interface CompareProject {
  /** The extension's root. */
  root: string;
  folder: string;
  main: string;
  /** The project's text files, by path from the folder. */
  files: string[];
  /** Its binary files (figures), given to the second core as to the first. */
  binaries: Record<string, Uint8Array>;
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

  async function pick(): Promise<void> {
    // (no git, or none yet: what Compare needs, said. The versions are the user's own commits,
    // made with their git or VS Code's Source Control: PhiTeX never commits)
    const scm = "Commit your versions with git on the command line or in VS Code's Source Control view";
    const git = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>("vscode.git");
    const api = git && vscode.workspace.getConfiguration("git").get<boolean>("enabled") !== false ? (git.isActive ? git.exports : await git.activate()).getAPI(1) : undefined;
    if (!api) return void vscode.window.showInformationMessage(`PhiTeX: Compare shows your document against an earlier version from git, and VS Code's Git is turned off. Turn on the git.enabled setting. ${scm}, then Compare again.`, "Open the setting").then((a) => a && vscode.commands.executeCommand("workbench.action.openSettings", "git.enabled"));
    const repo = api.getRepository(vscode.Uri.file(p.folder));
    if (!repo) return void vscode.window.showInformationMessage(`PhiTeX: Compare shows your document against an earlier version from git, and this folder isn't a git repository yet. Start one with git init, or Initialize Repository in VS Code's Source Control view. ${scm}, then Compare again.`, "Open Source Control").then((a) => a && vscode.commands.executeCommand("workbench.view.scm"));
    const commits = await repo.log({ maxEntries: 200 }).catch(() => [] as GitCommit[]);
    if (!commits.length) return void vscode.window.showInformationMessage(`PhiTeX: this repository has no commits to compare with yet. ${scm}, then Compare again.`, "Open Source Control").then((a) => a && vscode.commands.executeCommand("workbench.view.scm"));
    type Item = vscode.QuickPickItem & { c: GitCommit };
    const choice = await vscode.window.showQuickPick<Item>(
      commits.map((c) => ({ label: c.message.split("\n")[0], description: c.hash.slice(0, 7), detail: [c.authorName, ago(c.authorDate)].filter(Boolean).join(" · "), c })),
      { title: "PhiTeX: compare the current version with…", matchOnDescription: true, matchOnDetail: true },
    );
    if (!choice) return;
    const old: Record<string, string> = {};
    // (the version's text files, those the project has now; one it lacked is left out)
    for (const f of p.files) {
      const t = await repo.show(choice.c.hash, join(p.folder, f)).catch(() => undefined);
      if (t !== undefined) old[f] = t;
    }
    comparing = true;
    post({ t: "cmp-start", v: choice.c.hash, title: choice.label, when: [ago(choice.c.authorDate), choice.c.hash.slice(0, 7)].filter(Boolean).join(" · "), old, main: p.main, files: await texts() });
  }

  async function open(): Promise<void> {
    try {
      second ??= await startCore(p.root, () => p.folder, p.log);
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
    if (m.t === "compare") return void pick().catch((e) => vscode.window.showErrorMessage(`PhiTeX: couldn't compare: ${e}`));
    if (m.t === "cmp-open") return void open();
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
