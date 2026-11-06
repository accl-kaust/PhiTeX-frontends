// The extension host's side of the webview's preview (webview.ts): its
// requests answered by a core, the core's events sent on (a strip's pixels
// as bytes: the webview composes the pages, strippages.ts). The core here is
// `phitex watch`'s (WatchLink: its WebSocket, and its doc.pdf for the
// pages, which the webview draws).

import * as vscode from "vscode";
import type { CoreEvent, CoreRes, CoreTransport } from "../../common/src/viewer/session.ts";
import type { Down, Up } from "./webview.ts";
import { latexdiff } from "./compare.ts";
import { availableParallelism } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** The webview's page: the panel's script from the extension's dist/, nothing else; `engine`: which one builds (its words). */
export function viewHtml(view: vscode.Webview, ext: vscode.Uri, engine: "builtin" | "watch"): string {
  const root = view.asWebviewUri(ext).toString().replace(/\/?$/, "/");
  const nonce = Math.random().toString(36).slice(2);
  const src = view.cspSource;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; font-src ${src} data:; style-src ${src} 'unsafe-inline'; script-src 'nonce-${nonce}' ${src} 'wasm-unsafe-eval'; connect-src ${src};">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh"><script nonce="${nonce}">window.PHITEX_ROOT=${JSON.stringify(root)};window.PHITEX_FONTS=${JSON.stringify(root + "fonts/")};window.PHITEX_ENGINE=${JSON.stringify(engine)};</script><script nonce="${nonce}" src="${root}dist/webview.js"></script></body></html>`;
}

/** What the webview of `view` asks, answered by `core`; `pdf`: its download asked; `folder`: the project's, its files' names from it. */
export function relay(view: vscode.WebviewPanel, core: CoreTransport, folder: string, pdf: () => void, log?: (s: string) => void): vscode.Disposable {
  core.onEvent?.((e: CoreEvent) => void view.webview.postMessage({ t: "event", e } satisfies Down));
  return view.webview.onDidReceiveMessage(async (m: Up) => {
    // (the webview's trace: errors and blocks always, the rest with phitex.trace)
    if (m.t === "log") {
      if (log && (vscode.workspace.getConfiguration("phitex").get<boolean>("trace") || /^ *\d+ ms {2}(error|rejected|blocked|draw:)/.test(m.s))) log("webview: " + m.s);
      return;
    }
    if (m.t === "pdf") pdf();
    // (a compare's own document's, channel 2: compare.ts's)
    if (m.t !== "req" || m.ch) return;
    // (latexdiff: here, the diff wasm, as Overleaf's offscreen page runs it;
    // the Settings dialog's: VS Code's own settings, here)
    const r =
      m.op.op === "latexdiff"
        ? await latexdiff(m.op.req as never)
        : m.op.op === "vsc-settings"
          ? settingsNow()
          : m.op.op === "vsc-set"
            ? await setSetting(String(m.op.key), m.op.value)
            : m.op.op === "vsc-source"
              ? await source(folder, String(m.op.file))
            : await core.request(m.op as never).catch((e): CoreRes => ({ ok: false, error: String(e) }));
    void view.webview.postMessage({ t: "res", id: m.id, r } satisfies Down);
  });
}

/** A project file's text (Copy for an AI assistant): its editor's, unsaved edits in, else the disk's; a file of the project only, at most 2 MB. */
async function source(folder: string, file: string): Promise<CoreRes> {
  if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) return { ok: false, error: "not a project file" };
  const path = join(folder, file);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === path);
  if (open) return { ok: true, json: { text: open.getText() } };
  try {
    if ((await stat(path)).size > 2 << 20) return { ok: false, error: "too large" };
    return { ok: true, json: { text: await readFile(path, "utf8") } };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** The settings the preview's Settings dialog shows and sets: VS Code's `phitex.*`. */
const SETTINGS = ["engine", "texEngine", "follow", "threads", "main", "path", "trace", "darkPdf", "opening", "underline"];

/** Their values now, and this machine's cores (Threads' list). */
function settingsNow(): CoreRes {
  const c = vscode.workspace.getConfiguration("phitex");
  return { ok: true, json: { ...Object.fromEntries(SETTINGS.map((k) => [k, c.get(k)])), cores: availableParallelism() } };
}

/** One set where it is set now (the workspace's, else the user's): its error, if VS Code refused it. */
async function setSetting(key: string, value: unknown): Promise<CoreRes> {
  if (!SETTINGS.includes(key)) return { ok: false, error: `no setting phitex.${key} here` };
  const c = vscode.workspace.getConfiguration("phitex");
  const at = c.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  try {
    await c.update(key, value, at);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * `phitex watch`'s viewer protocol, from the extension host: its requests
 * and events over its WebSocket (joined again when it drops), a page's
 * `frame` and its `strips` over the watch's HTTP (`frame/K/S`,
 * `strips/KEYS`, as the watch's own page asks), and `pdf` its doc.pdf.
 */
export class WatchLink implements CoreTransport {
  private ws?: WebSocket;
  private next = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  private events: ((e: CoreEvent) => void)[] = [];
  private closed = false;
  private base: string;
  /** The next open (a request waits for it), and whether it opened before (a join again redraws). */
  private wake: () => void = () => {};
  private ready = new Promise<void>((ok) => (this.wake = ok));
  private was = false;

  /** The viewer's address, `http://127.0.0.1:PORT/TOKEN/`. */
  constructor(base: string) {
    this.base = base;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(new URL("ws", this.base).href.replace(/^http/, "ws"));
    this.ws = ws;
    ws.onopen = () => {
      const wake = this.wake;
      this.ready = new Promise<void>((ok) => (this.wake = ok));
      wake();
      // (joined again: what changed meanwhile drawn)
      if (this.was) this.events.forEach((f) => f({ event: "settled" } as CoreEvent));
      this.was = true;
    };
    ws.onmessage = (m) => {
      const r = JSON.parse(String(m.data));
      if (r.event) {
        return this.events.forEach((f) => f(r));
      }
      this.waiting.get(r.id)?.(r);
      this.waiting.delete(r.id);
    };
    ws.onclose = () => {
      for (const f of this.waiting.values()) f({ ok: false, error: "closed" });
      this.waiting.clear();
      // (the watch restarted, or the connection blinked: joined again)
      if (!this.closed) setTimeout(() => this.open(), 1000);
    };
  }

  private async pdf(): Promise<Uint8Array | null> {
    const r = await fetch(new URL("doc.pdf", this.base), { cache: "no-store" });
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  }

  async request(req: object): Promise<CoreRes> {
    const o = req as { op: string; page?: number };
    if (o.op === "pdf") {
      const pdf = await this.pdf();
      return pdf ? { ok: true, pdf } : { ok: false, error: "no PDF yet" };
    }
    // (the pages as strips, over the watch's HTTP: a page's frame, the strips' pixels)
    if (o.op === "frame") {
      const { page, scale, win } = req as { page?: number; scale: number; win?: number[] };
      const r = await fetch(new URL(`frame/${page ?? 0}/${Math.round(scale * 1000)}${part(win)}`, this.base), { cache: "no-store" });
      return r.ok ? { ok: true, json: await r.json() } : { ok: false, error: `frame: ${r.status}` };
    }
    // (frame_with, as the core answers it: the frame, then the strips the viewer lacks, in one buffer)
    if (o.op === "frame_with") {
      const { page, scale, have, win } = req as { page?: number; scale: number; have: string[]; win?: number[] };
      const r = await fetch(new URL(`frame/${page ?? 0}/${Math.round(scale * 1000)}${part(win)}`, this.base), { cache: "no-store" });
      if (!r.ok) return { ok: false, error: `frame: ${r.status}` };
      const f = (await r.json()) as { bands: [string, number, number][]; sent?: string[] };
      const held = new Set(have);
      f.sent = [...new Set(f.bands.map((b) => b[0]).filter((k) => !held.has(k)))];
      const s = f.sent.length ? await fetch(new URL(`strips/${f.sent.join(",")}`, this.base), { cache: "no-store" }) : null;
      const strips = s?.ok ? new Uint8Array(await s.arrayBuffer()) : new Uint8Array(0);
      const json = new TextEncoder().encode(JSON.stringify(f));
      const out = new Uint8Array(4 + json.length + strips.length);
      new DataView(out.buffer).setUint32(0, json.length, true);
      out.set(json, 4);
      out.set(strips, 4 + json.length);
      return { ok: true, bytes: out } as CoreRes;
    }
    if (o.op === "strips") {
      const r = await fetch(new URL(`strips/${(req as { keys: string[] }).keys.join(",")}`, this.base), { cache: "no-store" });
      return r.ok ? ({ ok: true, bytes: new Uint8Array(await r.arrayBuffer()) } as CoreRes) : { ok: false, error: `strips: ${r.status}` };
    }
    while (this.ws?.readyState !== WebSocket.OPEN && !this.closed) await this.ready;
    const id = this.next++;
    return new Promise((ok) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return ok({ ok: false, error: "not connected" });
      this.waiting.set(id, ok);
      this.ws.send(JSON.stringify({ id, ...o }));
    });
  }

  onEvent(cb: (e: CoreEvent) => void): void {
    this.events.push(cb);
  }

  close(): void {
    this.closed = true;
    this.wake();
    this.ws?.close();
  }
}

/** A page's part in the watch's frame URL (`frame/K/S/L,T,R,B`; none: the whole page). */
function part(win?: number[]): string {
  return win ? `/${win.map((x) => x.toFixed(5)).join(",")}` : "";
}
