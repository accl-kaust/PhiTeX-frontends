import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreSession, type Core } from "../common/src/wasm/core.ts";
import type { CoreEvent } from "../common/src/viewer/session.ts";

/** A core that only tells events (`tell`), as the wasm core's thread 0 hears them. */
function fakeCore() {
  let heard: (e: unknown) => void = () => {};
  const core = { onEvent: (f: (e: unknown) => void) => void (heard = f) } as unknown as Core;
  return { core, tell: (e: unknown) => heard(e) };
}

test("a closed preview's listener, left, keeps a later preview from hearing the core", () => {
  const { core, tell } = fakeCore();
  const session = new CoreSession(core);
  // (VS Code's builtin core outlives its previews: the first, closed, throws on postMessage)
  const off = session.onEvent(() => {
    throw new Error("Webview is disposed");
  });
  const heard: CoreEvent[] = [];
  session.onEvent((e) => heard.push(e));
  // (left listening, it stops the event before the open preview hears it)
  assert.throws(() => tell({ event: "build" }), /Webview is disposed/);
  assert.equal(heard.length, 0);
  // (stopped, as relay's dispose does: the open preview hears every event)
  off();
  tell({ event: "build" });
  tell({ event: "settled" });
  assert.deepEqual(heard.map((e) => e.event), ["build", "settled"]);
});
