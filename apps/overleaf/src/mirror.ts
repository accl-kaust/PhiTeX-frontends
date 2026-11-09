// Overleaf's "Open PDF in separate tab": the detached tab has no editor, so
// it mirrors the editor tab's session. The editor tab sends everything its
// sink is told (remote.ts's tee); the detached tab asks for the pages it
// scrolls to. One BroadcastChannel a project, between the two tabs' content
// scripts.
//
// A page's drawing is a canvas (the strips composed, strips.ts), which no
// channel carries: the editor tab sends a page without it (mirrorOut), and
// the detached tab composes its own from the same strips, at its own zoom
// and over the part of the page in its own view, asking the editor tab's
// core for them (core asks, answered by `cored`).

import type { CoreReq, CoreRes, CoreTransport, PageImage, PreviewSink } from "./common/viewer/session.ts";
import { apply, tee, type Told } from "./common/viewer/remote.ts";

export { tee };

/** Detached → editor. */
export type Ask =
  | { t: "hello" }
  | { t: "need"; k: number }
  | { t: "page"; k: number }
  | { t: "goto"; file: string; line: number }
  | { t: "sync"; k: number; x: number; y: number }
  | { t: "bye" }
  /** A request for the editor tab's core (a page's frame, its strips), answered by `cored` with the same id. */
  | { t: "core"; id: string; op: CoreReq };

/** Editor → detached: a `core` ask's answer. */
export type Cored = { t: "cored"; id: string; res: CoreRes };

export const channel = (project: string) => new BroadcastChannel(`phitex:${project}`);

/** A page told without its drawing (what the detached tab draws itself): its size and links. */
type Stub = Pick<PageImage, "w" | "h" | "links">;

/** The editor tab's side of `ch` for tee: every sink call as it is, but a page's without its canvas (it doesn't clone: the call was dropped, and the detached tab stayed blank). */
export function mirrorOut(ch: BroadcastChannel): { postMessage(m: Told): void } {
  return {
    postMessage(m) {
      if (m.t === "sink" && m.m === "page" && m.a[0]) {
        const { w, h, links } = m.a[0] as PageImage;
        m = { ...m, a: [{ w, h, links } satisfies Stub, ...m.a.slice(1)] };
      }
      ch.postMessage(m);
    },
  };
}

/** The editor tab's answer to a detached tab's `core` ask, from `t` (the pages' transport; none yet: not ok). */
export async function answer(ch: BroadcastChannel, a: Extract<Ask, { t: "core" }>, t: CoreTransport | undefined): Promise<void> {
  const res: CoreRes = t ? await t.request(a.op).catch(() => ({ ok: false })) : { ok: false };
  // (a page's drawing never goes: the detached tab asks frames and strips, plain bytes)
  delete res.canvas;
  ch.postMessage({ t: "cored", id: a.id, res } satisfies Cored);
}

/** How long a `core` ask waits for the editor tab (gone, or not started: not ok). */
const CORE_WAIT_MS = 20_000;

/** The editor tab's core, over `ch`: for the detached tab's own StripPages. */
export function remoteCore(ch: BroadcastChannel): CoreTransport {
  const me = Math.random().toString(36).slice(2);
  let n = 0;
  const waiting = new Map<string, (r: CoreRes) => void>();
  ch.addEventListener("message", (e: MessageEvent<Cored>) => {
    if (e.data?.t !== "cored") return;
    const ok = waiting.get(e.data.id);
    // (two editor tabs of the project both answer: the first wins)
    if (ok) waiting.delete(e.data.id), ok(e.data.res);
  });
  return {
    request(op) {
      const id = `${me}:${++n}`;
      return new Promise((ok) => {
        waiting.set(id, ok);
        ch.postMessage({ t: "core", id, op } satisfies Ask);
        setTimeout(() => waiting.delete(id) && ok({ ok: false, json: { error: "the editor tab didn't answer" } }), CORE_WAIT_MS);
      });
    },
  };
}

/**
 * In the detached tab: the editor tab's sink calls, applied to ours. A page
 * (told without its drawing) is drawn here by `draw` (this tab's
 * StripPages' png over remoteCore), then told to the sink; a page told
 * again before an older one's drawing came wins over it.
 */
export function follow(ch: BroadcastChannel, sink: PreviewSink, draw: (k: number) => Promise<CoreRes>): void {
  const latest = new Map<number, number>();
  let seq = 0;
  ch.addEventListener("message", (e: MessageEvent<Told>) => {
    // (the editor tab (re)started after us: say hello again)
    if (e.data?.t === "up") return ch.postMessage({ t: "hello" } satisfies Ask);
    if (e.data?.t === "sink" && e.data.m === "page" && e.data.a[0]) {
      const [, k, n, hash] = e.data.a as [Stub, number, number, string | null | undefined];
      const mine = ++seq;
      latest.set(k, mine);
      void draw(k).then((r) => {
        // (not drawn (the editor tab gone): the page as it was; asked again when it is wanted)
        if (latest.get(k) !== mine || !r.ok || !r.canvas || !r.size) return;
        sink.page({ canvas: r.canvas, w: r.size[0], h: r.size[1], links: r.links }, k, n, hash);
      });
      return;
    }
    apply(sink, e.data);
  });
  ch.postMessage({ t: "hello" } satisfies Ask);
  addEventListener("pagehide", () => ch.postMessage({ t: "bye" } satisfies Ask));
}
