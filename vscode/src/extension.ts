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
import { AbstractMessageReader, AbstractMessageWriter, CloseAction, ErrorAction, ExecuteCommandRequest, LanguageClient, State, type DataCallback, type LanguageClientOptions, type Message, type ShowDocumentParams, type ShowDocumentResult } from "vscode-languageclient/node";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { setPlatform } from "../../common/src/platform.ts";
import type { CoreTransport } from "../../common/src/viewer/session.ts";
import type { Core, CoreSession } from "../../common/src/wasm/core.ts";
import { findMain, relPath } from "./changes.ts";
import { prefetch, startCore } from "./core.ts";
import { lspChannel, type CoreIndex, type LspChannel } from "../../common/src/wasm/host.ts";
import { nodePlatform } from "./platform.ts";
import { relay, viewHtml, WatchLink } from "./relay.ts";
import type { Down } from "./webview.ts";
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

/** Where this host keeps its store (the builtin's caches). */
let storeDir = "";
/** The status bar's item (status.ts). */
let status: StatusItem;
/** The preview last opened: what the menu's Stop, Restart and Save PDF act on. */
let current: { folder: string; view: vscode.WebviewPanel; save(): void } | undefined;

/** The language server of the preview open (the watch's), for the protocol's commands (docs/spec-editor-protocol.md). */
let server: LanguageClient | undefined;
const setServer = (c: LanguageClient | undefined) => {
  server = c;
  void vscode.commands.executeCommand("setContext", "phitex.lsp", !!c);
};
/** The server's command `command` with `arg`; its answer, or undefined (an error said). */
async function exec<T>(command: string, arg?: unknown): Promise<T | undefined> {
  if (!server) return void vscode.window.showWarningMessage("PhiTeX: open the preview first.");
  try {
    return (await server.sendRequest(ExecuteCommandRequest.type, { command, arguments: arg === undefined ? [] : [arg] })) as T;
  } catch (e) {
    void vscode.window.showErrorMessage(`PhiTeX: ${(e as Error).message ?? e}`);
  }
}
const size = (b: number) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.round(b / 1024)} kB`);
type Cache = { scope: "build" | "packages"; location: string; bytes: number; entries: number; last_used: string | null; hits: number; misses: number };
const ago = (iso: string | null) => {
  if (!iso) return "never used";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 90 ? "used just now" : s < 5400 ? `used ${Math.round(s / 60)} min ago` : s < 129600 ? `used ${Math.round(s / 3600)} h ago` : `used ${Math.round(s / 86400)} days ago`;
};

/** The settings the engine takes (section "phitex": docs/spec-editor-protocol.md §3.5); threads 0, its default (a thread a core). */
const settings = () => {
  const c = vscode.workspace.getConfiguration("phitex");
  const threads = c.get<number>("threads") || availableParallelism();
  return { threads, main: c.get<string>("main") || undefined, follow: c.get<string>("follow") ?? "cursor" };
};

/** This extension, as the server is told (initializationOptions.client: docs/spec-editor-protocol.md §1); set at activation. */
let clientInfo = { name: "phitex-vscode", version: "" };
/** The editor protocol this extension speaks: an older server's (capabilities.experimental.phitex.protocol) is said. */
const PROTOCOL = 1;

/** Which engine builds: the setting phitex.engine. */
const engineSetting = () => (vscode.workspace.getConfiguration("phitex").get<string>("engine") === "phitex watch" ? "phitex watch" : "builtin");

export function activate(ctx: vscode.ExtensionContext): void {
  const root = ctx.extensionPath;
  clientInfo = { name: "phitex-vscode", version: ctx.extension.packageJSON.version };
  storeDir = join(ctx.globalStorageUri.fsPath, "store");
  setPlatform(nodePlatform(root, storeDir));
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
    vscode.commands.registerCommand("phitex.rebuild", () => exec("phitex.rebuild")),
    vscode.commands.registerCommand("phitex.clearCache", async (scope?: string) => {
      scope ??= (await vscode.window.showQuickPick(["build", "packages", "all"], { title: "PhiTeX: clear which cache?" })) ?? undefined;
      if (!scope) return;
      const r = await exec<{ freed_bytes: number }>("phitex.clearCache", { scope });
      if (r) void vscode.window.showInformationMessage(`PhiTeX: the ${scope === "all" ? "" : scope + " "}cache${scope === "all" ? "s" : ""} cleared, ${size(r.freed_bytes)} freed.`);
    }),
    vscode.commands.registerCommand("phitex.caches", async () => {
      const r = await exec<{ caches: Cache[] }>("phitex.cacheStats");
      if (!r) return;
      type Item = vscode.QuickPickItem & { scope?: string };
      const name = { build: "Build cache", packages: "Package cache" };
      const items: Item[] = r.caches.map((c) => ({
        label: `$(database) ${name[c.scope] ?? c.scope}`,
        description: `${size(c.bytes)} · ${c.entries} entries`,
        detail: `${c.location} · ${ago(c.last_used)} · this session: ${c.hits} hits, ${c.misses} misses`,
        scope: c.scope,
      }));
      items.push({ label: "$(trash) Clear all", scope: "all" });
      const pick = await vscode.window.showQuickPick(items, { title: "PhiTeX: caches (pick one to clear it)" });
      if (!pick?.scope) return;
      const what = pick.scope === "all" ? "every cache" : `the ${pick.scope} cache`;
      if ((await vscode.window.showWarningMessage(`PhiTeX: clear ${what}?`, { modal: true }, "Clear")) === "Clear") await vscode.commands.executeCommand("phitex.clearCache", pick.scope);
    }),
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
              ...(server ? [{ label: "$(refresh) Rebuild from scratch", run: () => exec("phitex.rebuild") }, { label: "$(database) Caches…", run: () => vscode.commands.executeCommand("phitex.caches") }] : []),
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

/** Previews whose engine is gone: kept, their pages dimmed (the viewer's banner says why); opening the preview again starts anew. */
const lost = new WeakSet<vscode.WebviewPanel>();
/** `view`'s engine gone by itself: its pages dimmed under the viewer's banner, kept until closed or restarted. */
function disconnected(view: vscode.WebviewPanel, why: string): void {
  lost.add(view);
  void view.webview.postMessage({ t: "connection", up: false, why } satisfies Down);
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
  if (builtinView && lost.has(builtinView)) builtinView.dispose();
  if (builtinView && builtinFolder === folder) return builtinView.reveal(vscode.ViewColumn.Beside, true);
  builtinView?.dispose();

  const project = await loadProject(folder);
  const main = settings().main ?? findMain(project.files, ed ? (relPath(folder, ed.document.uri.fsPath) ?? undefined) : undefined);
  if (!main) return void vscode.window.showErrorMessage("PhiTeX: no .tex file with \\documentclass in this folder.");
  builtinFolder = folder;
  // (the engine's threads: this machine's cores, as in the browser: overleaf/src/worker.ts)
  if (!builtin) {
    status.set({ state: "starting", engine: "wasm" });
    const started = (builtin = startCore(root, () => builtinFolder, (s) => log.append(s.endsWith("\n") ? s : s + "\n"), settings().threads, undefined, (why) => {
      // (a trap: this core is gone, the next preview starts another; this one's pages kept, dimmed)
      if (builtin === started) builtin = undefined;
      if (builtinView) disconnected(builtinView, `the builtin engine stopped: ${why}`);
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
  // (the document's language server, in this process: the editor's buffers,
  // diagnostics, a double-click's source (window/showDocument), the cursor,
  // the commands, as with the watch's; the caches' commands answered here)
  const channel = lspChannel(core, storeDir);
  const client = ownCommands(new LanguageClient("phitex", "PhiTeX", async () => ({ reader: new ChannelReader(channel), writer: new ChannelWriter(channel) }), clientOptions(folder, log)));
  let closed = false;
  const subs: vscode.Disposable[] = [relay(view, session, () => void savePdf(session, folder, main), (s) => log.appendLine(s))];
  current = { folder, view, save: () => void savePdf(session, folder, main) };
  view.onDidDispose(() => {
    closed = true;
    subs.forEach((s) => s.dispose());
    if (current?.view === view) current = undefined;
    if (server === client) setServer(undefined);
    if (builtinView === view) builtinView = undefined;
    // (the server told it ends, then the document closed: the core idle until the next
    // preview, which waits for this; a core that trapped is gone already)
    const s = client.stop(2000).catch(() => undefined).then(() => {
      channel.close();
      if (!builtinView && builtin) core.close();
    });
    stopping.add(s);
    void s.finally(() => stopping.delete(s));
    if (status.state !== "crashed" && status.state !== "stopped") status.set({ state: "off" });
  });

  // (the project's binary files first, then its text and the open)
  await Promise.all(stopping);
  for (const [file, bytes] of Object.entries(project.binaries)) core.provide(file, { path: "./" + file, bytes });
  prefetch(core, index, project.files, "pdflatex");
  const r = await session.request({ op: "open", main, files: project.files } as never);
  if (!r.ok) {
    log.appendLine(`open: ${r.error}`);
    void vscode.window.showErrorMessage(`PhiTeX: ${r.error}`);
    return view.dispose();
  }
  if (closed) return;
  const opened = settings();
  subs.push(
    client.onNotification("phitex/status", (s: EngineStatus) => status.set(s)),
    followCursor(client, folder),
    // (what only this host does, the core's events: stopped (phitex.stop), the preview
    // closed; the engine's settings changed (threads, main), the preview opened again)
    { dispose: session.onEvent((e) => {
      const c = e as { event: string; settings?: { main?: string } };
      if (c.event === "stop") view.dispose();
      if (c.event === "configure" && (c.settings?.main ?? opened.main) !== opened.main) void vscode.commands.executeCommand("phitex.restart");
    }) },
  );
  await client.start();
  if (!closed) setServer(client);
}

/**
 * `client` leaving the server's commands (executeCommandProvider) to this
 * extension, which offers them itself (activate's, through exec()): the
 * client's own registration of each as a VS Code command clashed with
 * ours, and with another client's still stopping ("command 'phitex.rebuild'
 * already exists": its initialization failed).
 */
function ownCommands(client: LanguageClient): LanguageClient {
  Object.assign(client.getFeature(ExecuteCommandRequest.method), { initialize: () => undefined, register: () => undefined });
  return client;
}

/** What the language client says to either engine's server: the folder's TeX buffers, its settings, no restart behind the user's back. */
function clientOptions(folder: string, log: vscode.OutputChannel): LanguageClientOptions {
  return {
    documentSelector: ["latex", "tex", "bibtex"].map((language) => ({ scheme: "file", language, pattern: `${folder}/**/*` })),
    workspaceFolder: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder)),
    outputChannel: log,
    // (the engine's settings: at the start, and each change (workspace/configuration))
    initializationOptions: { ...settings(), client: clientInfo },
    synchronize: { configurationSection: "phitex" },
    // (never restarted behind the user's back: the watch's viewer's address would change
    // under the preview, the builtin's document is the preview's; an exit is said, with
    // Restart offered: crashed())
    errorHandler: { error: () => ({ action: ErrorAction.Continue }), closed: () => ({ action: CloseAction.DoNotRestart, handled: true }) },
    // (a double-click on the pages: its source in the editor beside them, never over them)
    middleware: { window: { showDocument: (params) => showSource(params) } },
  };
}

/**
 * window/showDocument's place in an editor: the column already showing that
 * file, else one showing another (the editor beside the preview), else a
 * new one beside; the client's own opens it in the active column, which is
 * the preview's after a double-click on its pages.
 */
async function showSource(params: ShowDocumentParams): Promise<ShowDocumentResult> {
  const uri = vscode.Uri.parse(params.uri);
  if (params.external) return { success: await vscode.env.openExternal(uri) };
  const isPreview = (t: vscode.Tab | undefined) => t?.input instanceof vscode.TabInputWebview && /phitex\.(preview|watch)$/.test(t.input.viewType);
  const column =
    vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn ??
    vscode.window.tabGroups.all.find((g) => !isPreview(g.activeTab))?.viewColumn ??
    vscode.ViewColumn.Beside;
  const r = params.selection;
  const selection = r && new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
  const editor = await vscode.window.showTextDocument(uri, { viewColumn: column, preserveFocus: !params.takeFocus, selection });
  if (selection) editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return { success: true };
}

/**
 * The cursor and its selection sent as they move (phitex/cursor with its
 * range: the cursor's word and line marked on the page, a selection's text
 * too, an empty one clearing it), the latest at most every 30 ms; as
 * phitex.follow says: "cursor" every move, "selection" only while there is
 * one (and as it ends), "dblclick" never.
 */
function followCursor(client: LanguageClient, folder: string): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: object | undefined;
  let selected = false;
  const at = (p: vscode.Position) => ({ line: p.line, character: p.character });
  return vscode.window.onDidChangeTextEditorSelection((e) => {
    const doc = e.textEditor.document;
    if (!relPath(folder, doc.uri.fsPath)) return;
    const f = settings().follow;
    const sel = e.selections[0];
    const ended = selected && sel.isEmpty;
    if (f === "dblclick" || (f === "selection" && sel.isEmpty && !ended)) return;
    selected = !sel.isEmpty;
    latest = { textDocument: { uri: doc.uri.toString() }, position: at(sel.active), range: { start: at(sel.anchor), end: at(sel.active) } };
    timer ??= setTimeout(() => {
      timer = undefined;
      void client.sendNotification("phitex/cursor", latest);
    }, 30);
  });
}

/** The builtin's language server's messages, as the client reads them. */
class ChannelReader extends AbstractMessageReader {
  private channel: LspChannel;
  constructor(channel: LspChannel) {
    super();
    this.channel = channel;
  }
  listen(cb: DataCallback): vscode.Disposable {
    this.channel.onMessage((m) => cb(m));
    return { dispose: () => undefined };
  }
}

/** The client's messages to the builtin's language server. */
class ChannelWriter extends AbstractMessageWriter {
  private channel: LspChannel;
  constructor(channel: LspChannel) {
    super();
    this.channel = channel;
  }
  async write(m: Message): Promise<void> {
    try {
      this.channel.send(m);
    } catch (e) {
      this.fireError(e as Error, m);
    }
  }
  end(): void {}
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
  // (one whose watch exited: closed, a new one started)
  const was = watchViews.get(folder);
  if (was && was !== "starting" && lost.has(was)) was.dispose();
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
  const main = settings().main ?? findMain(files, active);
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
  const client = ownCommands(new LanguageClient(
    "phitex",
    "PhiTeX",
    { command: cmd, args: ["watch", main, "--lsp"], options: { cwd: folder, env: { ...process.env, CI: "" } } },
    clientOptions(folder, log),
  ));
  watches.add(client);
  // (the tab closed, even while the watch starts: the watch ends with it)
  let closed = false;
  const subs: vscode.Disposable[] = [];
  view.onDidDispose(() => {
    closed = true;
    if (current?.view === view) current = undefined;
    if (server === client) setServer(undefined);
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
  // (a phitex older than this extension's protocol: said, the preview opened all the same)
  const init = client.initializeResult;
  if (!(Number(init?.capabilities.experimental?.phitex?.protocol) >= PROTOCOL)) {
    void vscode.window.showErrorMessage(`PhiTeX: PhiTeX ${init?.serverInfo?.version ?? "(of an unknown version)"} is older than this extension needs: update phitex.`);
  }
  const link = new WatchLink(page0);
  current = { folder, view, save: () => void savePdf(link, folder, main) };
  setServer(client);
  // (the viewer's events too: its progress, until phitex/status says it all)
  link.onEvent((e) => status.event(e as never));
  if (status.state === "starting") status.set({ state: "ready" });
  view.webview.html = viewHtml(view.webview, ext, "watch");
  subs.push(
    relay(view, link, () => void savePdf(link, folder, main), (s) => log.appendLine(s)),
    { dispose: () => link.close() },
  );
  subs.push(
    followCursor(client, folder),
    client.onDidChangeState((s) => {
      if (s.newState !== State.Stopped) return;
      log.appendLine("phitex watch ended");
      if (closed) return;
      // (stopped as asked, phitex.stop: its last phitex/status said so; else it exited by itself)
      if (status.state === "stopped") return void view.dispose();
      status.set({ state: "crashed" });
      disconnected(view, "phitex watch exited");
      crashed("phitex watch exited.", log);
    }),
  );
}

export function deactivate(): void {
  for (const c of watches) void c.stop().catch(() => undefined);
  void builtin?.then(({ core }) => core.end()).catch(() => undefined);
  builtin = undefined;
}
