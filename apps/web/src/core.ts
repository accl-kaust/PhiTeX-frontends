// The core, for the page: a module worker running the Overleaf extension's
// own thread 0 (overleaf/src/worker.ts, its threads thread.ts), its
// requests answered by id and its events pushed (worker.ts's protocol).
// The `latexdiff` op, which the extension's offscreen document answers, is
// answered here (diff.ts on dist/diff.wasm, loaded at the first compare).

import type { CoreEvent, CoreRes, CoreTransport } from "../../../common/src/viewer/session.ts";
import { loadDiff, type DiffReq, type DiffReply } from "../../../common/src/viewer/diff.ts";
import { platform } from "../../../common/src/platform.ts";

let diff: Promise<(r: DiffReq) => DiffReply> | undefined;

/** A reply or an event, as the worker posts them. */
type FromWorker = (CoreRes & { id: number }) | (CoreEvent & { id?: undefined });

export class WorkerCore implements CoreTransport {
  private next = 1;
  private waiting = new Map<number, (r: CoreRes) => void>();
  private events: ((e: CoreEvent) => void)[] = [];
  private w: Worker;
  /** Why the worker is gone, if it is. */
  gone: string | undefined;

  constructor(project: string) {
    this.w = new Worker(new URL("worker.js", import.meta.url), { type: "module", name: "phitex-core" });
    this.w.onmessage = (m: MessageEvent<FromWorker>) => {
      const d = m.data;
      if (typeof d.id === "number") {
        this.waiting.get(d.id)?.(d);
        this.waiting.delete(d.id);
      } else for (const f of this.events) f(d);
    };
    this.w.onerror = (e) => {
      this.gone = `the engine's worker failed: ${e.message}`;
      for (const [, f] of this.waiting) f({ ok: false, error: this.gone });
      this.waiting.clear();
    };
    void this.request({ op: "hello", project });
  }

  request(op: { op: string; [k: string]: unknown }): Promise<CoreRes> {
    if (op.op === "latexdiff") return this.latexdiff(op.req as DiffReq);
    if (this.gone) return Promise.resolve({ ok: false, error: this.gone });
    const id = this.next++;
    return new Promise((ok) => {
      this.waiting.set(id, ok);
      this.w.postMessage({ ...op, id });
    });
  }

  private async latexdiff(req: DiffReq): Promise<CoreRes> {
    try {
      diff ??= platform()
        .asset("dist/diff.wasm")
        .then(async (r) => loadDiff(await r.arrayBuffer()));
      return { ok: true, json: (await diff)(req) } as CoreRes;
    } catch (e) {
      return { ok: false, error: `latexdiff: ${e}` };
    }
  }

  /** A project's binary file (a figure) given to the core. */
  binary(file: string, bytes: Uint8Array): Promise<CoreRes> {
    return this.request({ op: "binary", file, bytes });
  }

  onEvent(cb: (e: CoreEvent) => void): () => void {
    this.events.push(cb);
    return () => void this.events.splice(this.events.indexOf(cb) >>> 0, 1);
  }

  close(): void {
    this.w.terminate();
    this.gone = "closed";
  }
}
