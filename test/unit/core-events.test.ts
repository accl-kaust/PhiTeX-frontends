import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreSession, type Core } from "../../common/src/wasm/core.ts";
import type { CoreEvent } from "../../common/src/viewer/session.ts";

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

test("an open withdraws the files the last open gave that the project no longer has, not one given since by another way", async () => {
  const said: string[] = [];
  const givings = new Map<string, number>();
  let k = 0;
  const core = {
    onEvent: () => {},
    idle: async () => {},
    open: () => {},
    request: () => ({ ok: true, json: {} }),
    provide: (n: string) => (said.push(`give ${n}`), givings.set(n, ++k), k),
    withdraw: (n: string) => (said.push(`withdraw ${n}`), givings.delete(n)),
    givingOf: (n: string) => givings.get(n),
  } as unknown as Core;
  const session = new CoreSession(core);
  const open = (files: Record<string, string>) => session.request({ op: "open", main: "main.tex", files } as never);
  await open({ "main.tex": "m", "a.tex": "a", "llncs.cls": "copy", "x.png": "" });
  assert.deepEqual(said.splice(0), ["give a.tex", "give llncs.cls", "give x.png"]);
  // (x.png given since as a figure, the host's `binary`: it stays)
  core.provide("x.png", { path: "./x.png", bytes: new Uint8Array([1]) });
  said.length = 0;
  // (a.tex and the project's llncs.cls removed: withdrawn, the class Shelf's again)
  await open({ "main.tex": "m", "b.tex": "b" });
  assert.deepEqual(said.splice(0), ["withdraw a.tex", "withdraw llncs.cls", "give b.tex"]);
  await open({ "main.tex": "m" });
  assert.deepEqual(said.splice(0), ["withdraw b.tex"]);
});
