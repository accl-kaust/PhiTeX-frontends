// The pages as strips (viewer/src/strips.ts, PhiTeX's renderer: crates/
// output/render) in a host's viewer, over its transport to the core (the
// wasm core's CoreSession, or `phitex watch`'s): `png` answered by Strips
// (a page's `frame` asked, only the strips it has not got fetched, the page
// composed here), `find` from the core's `text` (every page's, asked again
// after each build); every other request the transport's. As the CLI's
// page does it (crates/cli/viewer/cli.ts's Pages).

import { Strips, type Frame, type StripSource } from "./viewer/strips.ts";
import { composeLine, search, type Hit, type TextLine } from "./viewer/text.ts";
import type { CoreEvent, CoreRes, CoreTransport } from "./viewer/session.ts";

/** What StripPages needs of the panel: its pixels a point, and the ⚡ chip told how long a change took to the screen. */
export interface StripPanel {
  pixelsPerPoint(): number;
  painted?(ms: number): void;
}

export class StripPages implements CoreTransport {
  private t: CoreTransport;
  private panel: StripPanel;
  private strips: Strips;
  /** A change on its way to the screen: ms from the edit to `settled`, and when that came. */
  private change: { since: number; at: number } | null = null;
  /** Every page's text, for finding (asked again after each build). */
  private texts: Promise<TextLine[][]> | null = null;

  /** `chip`: where the last frame's numbers are shown (none: not shown). */
  constructor(t: CoreTransport, panel: StripPanel, chip: HTMLElement | null = null) {
    [this.t, this.panel] = [t, panel];
    const src: StripSource = {
      frame: async (k, scale) => {
        const r = await t.request({ op: "frame", page: k, scale } as never);
        return r.ok ? (r.json as Frame) : null;
      },
      strips: async (keys) => {
        const r = (await t.request({ op: "strips", keys } as never)) as CoreRes & { bytes?: Uint8Array };
        if (!r.ok || !r.bytes) return null;
        const b = r.bytes;
        return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.slice().buffer as ArrayBuffer);
      },
    };
    this.strips = new Strips(src, chip);
    t.onEvent?.((e) => {
      if (e.event !== "settled") return;
      this.texts = null;
      const since = (e as { since_ms?: number | null }).since_ms;
      this.change = typeof since === "number" ? { since, at: performance.now() } : null;
    });
  }

  async request(op: object): Promise<CoreRes> {
    const o = op as { op: string; page?: number };
    if (o.op === "png") {
      const p = await this.strips.page(o.page ?? 0, this.panel.pixelsPerPoint()).catch((e) => (console.warn("[phitex] page", e), null));
      if (!p) return { ok: false, json: { error: "no such page" } };
      this.painted();
      return { ok: true, canvas: p.el, size: [p.w, p.h], links: p.links };
    }
    return this.t.request(op as never);
  }

  /** The first page drawn after a change: on the screen at the next frame; the ⚡ chip told how long from the edit. */
  private painted(): void {
    const c = this.change;
    if (!c) return;
    this.change = null;
    requestAnimationFrame(() => {
      const ms = c.since + performance.now() - c.at;
      this.panel.painted?.(ms);
      void this.t.request({ op: "painted", ms } as never);
    });
  }

  /** Where `q` is in the build's pages (their text as the core reads it). */
  async find(q: string): Promise<Hit[]> {
    this.texts ??= this.t
      .request({ op: "text" } as never)
      .then((r) => (r.ok ? ((r.json?.pages ?? []) as TextLine[][]).map((lines) => lines.map(composeLine)) : []));
    return search(await this.texts, q);
  }

  onEvent(cb: (e: CoreEvent) => void): void {
    this.t.onEvent?.(cb);
  }

  /** Let go of the transport (a compare's session stopped). */
  close(): void {
    (this.t as { close?(): void }).close?.();
  }
}
