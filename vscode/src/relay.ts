// The extension host's side of the webview's preview (webview.ts): its
// requests answered by a core, the core's events sent on. The core here is
// `phitex watch`'s (WatchLink: its WebSocket, and its doc.pdf for the
// pages, which the webview draws).

import * as vscode from "vscode";
import type { CoreEvent, CoreRes, CoreTransport } from "../../common/src/viewer/session.ts";
import type { Down, Up } from "./webview.ts";

/** The webview's page: the panel's script and MuPDF from the extension's dist/, nothing else. */
export function viewHtml(view: vscode.Webview, ext: vscode.Uri): string {
  const root = view.asWebviewUri(ext).toString().replace(/\/?$/, "/");
  const nonce = Math.random().toString(36).slice(2);
  const src = view.cspSource;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} data: blob:; font-src ${src} data:; style-src ${src} 'unsafe-inline'; script-src 'nonce-${nonce}' ${src} 'wasm-unsafe-eval'; connect-src ${src};">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;height:100vh"><script nonce="${nonce}">window.PHITEX_ROOT=${JSON.stringify(root)};window.PHITEX_FONTS=${JSON.stringify(root + "fonts/")};</script><script nonce="${nonce}" src="${root}dist/webview.js"></script></body></html>`;
}

/** What the webview of `view` asks, answered by `core`; `pdf`: its download asked. */
export function relay(view: vscode.WebviewPanel, core: CoreTransport & { joined?(): void }, pdf: () => void): vscode.Disposable {
  core.onEvent?.((e: CoreEvent) => void view.webview.postMessage({ t: "event", e } satisfies Down));
  return view.webview.onDidReceiveMessage(async (m: Up) => {
    if (m.t === "hello") core.joined?.();
    if (m.t === "pdf") pdf();
    if (m.t !== "req") return;
    const r = await core.request(m.op as never).catch((e): CoreRes => ({ ok: false, error: String(e) }));
    void view.webview.postMessage({ t: "res", id: m.id, r } satisfies Down);
  });
}

/**
 * `phitex watch`'s viewer protocol, from the extension host: its requests
 * and events over its WebSocket (joined again when it drops), and `png`
 * answered with its doc.pdf's key (the builds settled), the PDF itself when
 * the webview doesn't have it yet.
 */
export class WatchLink implements CoreTransport {
  private ws?: WebSocket;
  private next = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  private events: ((e: CoreEvent) => void)[] = [];
  /** The builds settled, and the one whose PDF the webview was sent. */
  private version = 0;
  private sent = -1;
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
      if (this.was) (this.version++, this.events.forEach((f) => f({ event: "settled" } as CoreEvent)));
      this.was = true;
    };
    ws.onmessage = (m) => {
      const r = JSON.parse(String(m.data));
      if (r.event) {
        if (r.event === "settled") this.version++;
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

  /** The webview (re)loaded: it has no PDF. */
  joined(): void {
    this.sent = -1;
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
    if (o.op === "png") {
      const v = this.version;
      const pdf = v === this.sent ? undefined : await this.pdf();
      if (v !== this.sent && !pdf) return { ok: false, error: "no PDF yet" };
      this.sent = v;
      return { ok: true, render: { page: o.page ?? 0, key: `watch:${v}` }, pdf } as CoreRes;
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
