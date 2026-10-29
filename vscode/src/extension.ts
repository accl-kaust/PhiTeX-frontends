// PhiTeX ⚡ Instant in VS Code: "PhiTeX: Open Preview" typesets the project
// the active .tex file is in and shows its pages in a webview beside the
// editor (webview.ts: the viewer every host shows, its session and panel,
// the pages drawn there by MuPDF). Its core is the builtin engine (core.ts:
// the wasm core in the extension host, CoreSession) or, with the setting
// phitex.engine "phitex watch", the native engine as the folder's language
// server; the webview's requests are relayed to it (relay.ts). The editor's
// changes go to the core as they are typed, the cursor's place too (its
// words marked on the page); a double-click on a page opens its source.

import * as vscode from "vscode";
import { readdir, readFile } from "node:fs/promises";
import { CloseAction, ErrorAction, LanguageClient, State } from "vscode-languageclient/node";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { setPlatform } from "../../common/src/platform.ts";
import type { CoreTransport } from "../../common/src/viewer/session.ts";
import type { Core, CoreSession } from "../../common/src/wasm/core.ts";
import { findMain, relPath } from "./changes.ts";
import { prefetch, startCore } from "./core.ts";
import type { CoreIndex } from "../../common/src/wasm/host.ts";
import { nodePlatform } from "./platform.ts";
import { relay, viewHtml, WatchLink } from "./relay.ts";
import { StatusItem, type EngineStatus } from "./status.ts";

/** The project's text files (what the core reads as source), and the binary ones it is given apart. */
const TEXT = /\.(tex|sty|cls|bib|bst|cfg|def|clo|fd|ltx|bbx|cbx|lbx|dtx|ins|txt|csv|dat|tikz|pgf|bbl)$/i;
const BINARY = /\.(png|jpe?g|pdf|eps|gif)$/i;
/** Folders never read (VCS, build output, dependencies). */
const SKIP = new Set([".git", "node_modules", ".vscode", "out", "build", ".phitex-diff"]);
/** The most files read from a folder (a project, not a home directory). */
const MAX_FILES = 4000;

async function walk(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (TEXT.test(e.name) || BINARY.test(e.name)) out.push(p);
  }
  return out;
}

/** The project in `folder`: its text files (the open documents' text over what is on disk) and its binary ones. */
async function loadProject(folder: string): Promise<{ files: Record<string, string>; binaries: Record<string, Uint8Array> }> {
  const files: Record<string, string> = {};
  const binaries: Record<string, Uint8Array> = {};
  for (const p of await walk(folder)) {
    const r = relPath(folder, p);
    if (!r) continue;
    if (BINARY.test(p)) binaries[r] = new Uint8Array(await readFile(p));
    else files[r] = await readFile(p, "utf8");
  }
  for (const d of vscode.workspace.textDocuments) {
    const r = d.uri.scheme === "file" ? relPath(folder, d.uri.fsPath) : null;
    if (r && TEXT.test(r)) files[r] = d.getText();
  }
  return { files, binaries };
}

/** `file:line:col` (from 1, as the core's `source` answers) opened in the editor. */
async function gotoPlace(folder: string, place: string): Promise<void> {
  const m = place.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return;
  const d = await vscode.workspace.openTextDocument(vscode.Uri.file(join(folder, m[1])));
  const at = new vscode.Position(Math.max(0, +m[2] - 1), Math.max(0, +m[3] - 1));
  const e = await vscode.window.showTextDocument(d, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(at, at) });
  e.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** The PDF `transport` gives, saved where the user says. */
async function savePdf(transport: CoreTransport, folder: string, main: string): Promise<void> {
  const r = await transport.request({ op: "pdf" });
  if (!r.pdf?.length) return void vscode.window.showWarningMessage("PhiTeX: no PDF yet (see the diagnostics).");
  const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(folder, main.replace(/\.tex$/, "") + ".pdf")) });
  if (to) await vscode.workspace.fs.writeFile(to, r.pdf);
}

let builtin: ReturnType<typeof startCore> | undefined;
/** The builtin engine's folder (its document keys), and its preview: the core holds one document, so one preview. */
let builtinFolder = "";
let builtinView: vscode.WebviewPanel | undefined;

/** The status bar's item (status.ts). */
let status: StatusItem;
/** The preview last opened: what the menu's Stop, Restart and Save PDF act on. */
let current: { folder: string; view: vscode.WebviewPanel; save(): void } | undefined;

/** Which engine builds: the setting phitex.engine. */
const engineSetting = () => (vscode.workspace.getConfiguration("phitex").get<string>("engine") === "phitex watch" ? "phitex watch" : "builtin");

export function activate(ctx: vscode.ExtensionContext): void {
  const root = ctx.extensionPath;
  const store = join(ctx.globalStorageUri.fsPath, "store");
  setPlatform(nodePlatform(root, store));
  const log = vscode.window.createOutputChannel("PhiTeX");
  status = new StatusItem();
  const open = (folder?: string) => preview(ctx, root, log, folder);
  /** The preview closed, its engine with it (the builtin core's document closed, the watch stopped). */
  const stop = () => current?.view.dispose();
  const restart = async () => {
    const folder = current?.folder;
    stop();
    await Promise.all(stopping);
    await open(folder);
  };
  ctx.subscriptions.push(
    log,
    status,
    vscode.commands.registerCommand("phitex.preview", () => open()),
    vscode.commands.registerCommand("phitex.stop", stop),
    vscode.commands.registerCommand("phitex.restart", restart),
    vscode.commands.registerCommand("phitex.savePdf", () => (current ? current.save() : void vscode.window.showWarningMessage("PhiTeX: open the preview first."))),
    vscode.commands.registerCommand("phitex.showLog", () => log.show()),
    vscode.commands.registerCommand("phitex.switchEngine", async () => {
      const to = engineSetting() === "builtin" ? "phitex watch" : "builtin";
      // (where it is set: the folder's settings if they say it, else the user's)
      const set = vscode.workspace.getConfiguration("phitex").inspect<string>("engine");
      const target = set?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : set?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration("phitex").update("engine", to, target);
      if (current) await restart();
      void vscode.window.showInformationMessage(`PhiTeX: the ${to === "builtin" ? "builtin engine (WebAssembly, in VS Code)" : "native engine (phitex watch)"} builds now.`);
    }),
    vscode.commands.registerCommand("phitex.menu", async () => {
      const other = engineSetting() === "builtin" ? "the native engine (phitex watch)" : "the builtin engine (WebAssembly)";
      type Item = vscode.QuickPickItem & { run(): unknown };
      const items: Item[] = [
        ...(current
          ? [
              { label: "$(eye) Show the preview", run: () => current?.view.reveal(vscode.ViewColumn.Beside, true) },
              { label: "$(file-pdf) Save the PDF…", run: () => current?.save() },
              { label: "$(debug-restart) Restart", run: restart },
              { label: "$(debug-stop) Stop", description: "closes the preview", run: stop },
            ]
          : [{ label: "$(zap) Open the preview", description: "Ctrl+Alt+P", run: () => open() }]),
        { label: "$(arrow-swap) Switch engine", description: `to ${other}`, run: () => vscode.commands.executeCommand("phitex.switchEngine") },
        { label: "$(output) Show the log", run: () => log.show() },
        { label: "$(gear) Settings", run: () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:accl-kaust.phitex-instant") },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: "PhiTeX", placeHolder: status.state === "off" ? "Not running" : `Running: ${engineSetting()}` });
      await pick?.run();
    }),
  );
}

/** The engine stopped by itself: the status bar says so, and a notification offers what to do. */
function crashed(why: string, log: vscode.OutputChannel): void {
  status.set({ state: "crashed" });
  void vscode.window.showErrorMessage(`PhiTeX: ${why}`, "Restart", "Show log").then((a) => {
    if (a === "Restart") void vscode.commands.executeCommand("phitex.restart");
    if (a === "Show log") log.show();
  });
}

async function preview(ctx: vscode.ExtensionContext, root: string, log: vscode.OutputChannel, at?: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const ws = at ? { uri: vscode.Uri.file(at) } : ed ? vscode.workspace.getWorkspaceFolder(ed.document.uri) : vscode.workspace.workspaceFolders?.[0];
  if (!ws || ws.uri.scheme !== "file") {
    void vscode.window.showErrorMessage("PhiTeX: open a .tex file in a folder first.");
    return;
  }
  const folder = ws.uri.fsPath;
  if (engineSetting() === "phitex watch") return previewWatch(ctx.extensionUri, folder, ed, log);
  if (builtinView && builtinFolder === folder) return builtinView.reveal(vscode.ViewColumn.Beside, true);
  builtinView?.dispose();

  const project = await loadProject(folder);
  const main = findMain(project.files, ed ? (relPath(folder, ed.document.uri.fsPath) ?? undefined) : undefined);
  if (!main) return void vscode.window.showErrorMessage("PhiTeX: no .tex file with \\documentclass in this folder.");
  builtinFolder = folder;
  // (the engine's threads: this machine's cores, as in the browser: overleaf/src/worker.ts)
  if (!builtin) {
    status.set({ state: "starting", engine: "wasm" });
    const started = (builtin = startCore(root, () => builtinFolder, (s) => log.append(s.endsWith("\n") ? s : s + "\n"), availableParallelism(), undefined, (why) => {
      // (a trap: this core is gone, the next preview starts another)
      if (builtin === started) builtin = undefined;
      const view = builtinView;
      builtinView = undefined;
      view?.dispose();
      crashed(`the builtin engine stopped (${why}).`, log);
    }));
    // (its events, once per core: the status bar's)
    void started.then(({ session }) => session.onEvent((e) => status.event(e as never)), () => undefined);
  }

  const view = vscode.window.createWebviewPanel("phitex.preview", "⚡ PhiTeX", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist"), vscode.Uri.joinPath(ctx.extensionUri, "fonts")],
  });
  builtinView = view;
  view.webview.html = viewHtml(view.webview, ctx.extensionUri, "builtin");
  if (status.state !== "starting") status.set({ state: "starting", engine: "wasm" });

  let core: Core, session: CoreSession, index: CoreIndex;
  try {
    ({ core, session, index } = await builtin);
  } catch (e) {
    builtin = undefined;
    log.appendLine(`core: ${e}`);
    view.dispose();
    status.set({ state: "off" });
    return void vscode.window.showErrorMessage(`PhiTeX: the engine did not start: ${e}`);
  }
  // (a double-click's source: the core says where, the editor goes there)
  const transport: CoreTransport = {
    request: async (op) => {
      const r = await session.request(op as never);
      if ((op as { op: string }).op === "source" && r.ok && typeof r.json?.place === "string") void gotoPlace(folder, r.json.place);
      return r;
    },
    onEvent: (cb) => session.onEvent(cb),
  };
  const rel = (d: vscode.TextDocument) => (d.uri.scheme === "file" ? relPath(folder, d.uri.fsPath) : null);
  let rest: ReturnType<typeof setTimeout> | undefined;
  const subs = [
    relay(view, transport, () => void savePdf(transport, folder, main), (s) => log.appendLine(s)),
    // (the editor's changes as they are typed: one change an edit, more the file's whole text)
    vscode.workspace.onDidChangeTextDocument((e) => {
      const r = rel(e.document);
      if (!r || !TEXT.test(r) || !e.contentChanges.length) return;
      const [c] = e.contentChanges;
      if (e.contentChanges.length === 1) core.push({ ask: "edit", file: r, start: c.rangeOffset, end: c.rangeOffset + c.rangeLength, text: c.text });
      else core.push({ ask: "set_file", file: r, text: e.document.getText() });
    }),
    // (the cursor, once it rests 150 ms: its words marked on the page)
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const r = rel(e.textEditor.document);
      if (!r) return;
      clearTimeout(rest);
      rest = setTimeout(() => {
        const at = e.selections[0].active;
        core.push({ ask: "cursor", file: r, line: at.line, col: at.character });
      }, 150);
    }),
  ];
  current = { folder, view, save: () => void savePdf(transport, folder, main) };
  view.onDidDispose(() => {
    subs.forEach((s) => s.dispose());
    if (current?.view === view) current = undefined;
    if (builtinView === view) builtinView = undefined;
    // (the document closed: the core idle until the next preview; a core that trapped is gone already)
    if (!builtinView && builtin) core.close();
    if (status.state !== "crashed") status.set({ state: "off" });
  });

  // (the project's binary files first, then its text and the open)
  for (const [file, bytes] of Object.entries(project.binaries)) core.provide(file, { path: "./" + file, bytes });
  prefetch(core, index, project.files, "pdflatex");
  const r = await session.request({ op: "open", main, files: project.files } as never);
  if (!r.ok) {
    log.appendLine(`open: ${r.error}`);
    void vscode.window.showErrorMessage(`PhiTeX: ${r.error}`);
  }
}

/**
 * The preview by `phitex watch --lsp` (the setting phitex.engine): the
 * native engine as this folder's language server. The editors' buffers are
 * built as they are typed (didChange), TeX's errors are diagnostics, a
 * double-click on a page opens its source here (window/showDocument), and
 * the cursor's words are marked on the page (phitex/cursor, when the
 * cursor rests). The watch serves the viewer every host shows (PhiTeX's
 * viewer/src) and says where (window/logMessage); the webview shows it.
 */
const watches = new Set<LanguageClient>();
/** Watches still stopping: a new one starts after them (each registers the server's commands, phitex.openViewer, which one stopping still holds). */
const stopping = new Set<Promise<void>>();
/** A folder's preview by its watch: one a folder, shown again when asked again. */
const watchViews = new Map<string, vscode.WebviewPanel | "starting">();
async function previewWatch(ext: vscode.Uri, folder: string, ed: vscode.TextEditor | undefined, log: vscode.OutputChannel): Promise<void> {
  const have = watchViews.get(folder);
  if (have === "starting") return;
  if (have) return have.reveal(vscode.ViewColumn.Beside, true);
  watchViews.set(folder, "starting");
  try {
    await startWatch(ext, folder, ed, log);
  } finally {
    if (watchViews.get(folder) === "starting") watchViews.delete(folder);
  }
}

async function startWatch(ext: vscode.Uri, folder: string, ed: vscode.TextEditor | undefined, log: vscode.OutputChannel): Promise<void> {
  const files: Record<string, string> = {};
  for (const p of await walk(folder)) {
    const r = relPath(folder, p);
    if (r && /\.tex$/i.test(r)) files[r] = await readFile(p, "utf8");
  }
  const active = ed ? (relPath(folder, ed.document.uri.fsPath) ?? undefined) : undefined;
  const main = findMain(files, active);
  if (!main) return void vscode.window.showErrorMessage("PhiTeX: no .tex file with \\documentclass in this folder.");
  const cmd = vscode.workspace.getConfiguration("phitex").get<string>("path") || "phitex";
  log.appendLine(`phitex watch: ${cmd} watch ${main} --lsp (in ${folder})`);
  // (the tab at once, saying what the watch does until its viewer is up: a
  // first run builds the format, seconds)
  const view = vscode.window.createWebviewPanel("phitex.watch", "⚡ phitex watch", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ext, "dist"), vscode.Uri.joinPath(ext, "fonts")],
  });
  watchViews.set(folder, view);
  status.set({ state: "starting", engine: "native" });
  const said: string[] = [];
  const waiting = () => {
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>
<body style="font:13px system-ui,sans-serif;padding:24px;color:var(--vscode-foreground)"><b>Starting phitex watch…</b><pre style="opacity:.75">${esc(said.slice(-8).join("\n"))}</pre></body></html>`;
  };
  waiting();
  const client = new LanguageClient(
    "phitex",
    "PhiTeX",
    { command: cmd, args: ["watch", main, "--lsp"], options: { cwd: folder, env: { ...process.env, CI: "" } } },
    {
      documentSelector: ["latex", "tex", "bibtex"].map((language) => ({ scheme: "file", language, pattern: `${folder}/**/*` })),
      workspaceFolder: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder)),
      outputChannel: log,
      // (never restarted behind the user's back: its viewer's address would change under the
      // preview; an exit is said, with Restart offered: crashed())
      errorHandler: { error: () => ({ action: ErrorAction.Continue }), closed: () => ({ action: CloseAction.DoNotRestart, handled: true }) },
    },
  );
  watches.add(client);
  // (the tab closed, even while the watch starts: the watch ends with it)
  let closed = false;
  const subs: vscode.Disposable[] = [];
  view.onDidDispose(() => {
    closed = true;
    if (current?.view === view) current = undefined;
    if (status.state !== "crashed" && status.state !== "stopped") status.set({ state: "off" });
    watchViews.delete(folder);
    subs.forEach((s) => s.dispose());
    watches.delete(client);
    const s = client.stop().catch(() => undefined);
    stopping.add(s);
    void s.finally(() => stopping.delete(s));
  });
  // (what the watch says: the tab's text while it starts, and the viewer's
  // address when it is up; once the viewer is shown, the log only)
  let shown = false;
  let found: (u: string | null) => void = () => undefined;
  const url = new Promise<string | null>((done) => (found = done));
  subs.push(
    // (what the engine is doing: the status bar's, docs/spec-editor-protocol.md)
    client.onNotification("phitex/status", (s: EngineStatus) => status.set(s)),
    // (the client writes each one to the PhiTeX output itself)
    client.onNotification("window/logMessage", (p: { message: string }) => {
      said.push(...p.message.split("\n").map((l) => l.trim()).filter(Boolean));
      if (!closed && !shown) waiting();
      const m = p.message.match(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\//);
      if (m) found(m[0]);
    }),
  );
  try {
    await Promise.all(stopping);
    await client.start();
  } catch (e) {
    log.appendLine(`phitex watch --lsp: ${e}`);
    found(null);
  }
  const page0 = await url;
  if (closed) return;
  if (!page0) {
    watches.delete(client);
    view.dispose();
    status.set({ state: "off" });
    void vscode.window.showErrorMessage(`PhiTeX: \`${cmd} watch --lsp\` did not start (see the PhiTeX output). Install phitex, or set phitex.path, or phitex.engine to "builtin".`, "Show output").then((a) => a && log.show());
    return;
  }
  // (the viewer in the webview, its core the watch's, through this host:
  // the watch's address is this host's, local to the watch)
  shown = true;
  const link = new WatchLink(page0);
  current = { folder, view, save: () => void savePdf(link, folder, main) };
  // (the viewer's events too: its progress, until phitex/status says it all)
  link.onEvent((e) => status.event(e as never));
  if (status.state === "starting") status.set({ state: "ready" });
  view.webview.html = viewHtml(view.webview, ext, "watch");
  subs.push(
    relay(view, link, () => void savePdf(link, folder, main), (s) => log.appendLine(s)),
    { dispose: () => link.close() },
  );
  // (the cursor, once it rests 150 ms: its words marked on the page)
  let rest: ReturnType<typeof setTimeout> | undefined;
  subs.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!relPath(folder, e.textEditor.document.uri.fsPath)) return;
      clearTimeout(rest);
      rest = setTimeout(() => {
        const at = e.selections[0].active;
        void client.sendNotification("phitex/cursor", { textDocument: { uri: e.textEditor.document.uri.toString() }, position: { line: at.line, character: at.character } });
      }, 150);
    }),
    client.onDidChangeState((s) => {
      if (s.newState !== State.Stopped) return;
      log.appendLine("phitex watch ended");
      if (closed) return;
      // (stopped as asked, phitex.stop: its last phitex/status said so; else it exited by itself)
      if (status.state === "stopped") return void view.dispose();
      status.set({ state: "crashed" });
      view.dispose();
      crashed("phitex watch exited.", log);
    }),
  );
}

export function deactivate(): void {
  for (const c of watches) void c.stop().catch(() => undefined);
  void builtin?.then(({ core }) => core.close()).catch(() => undefined);
  builtin = undefined;
}
