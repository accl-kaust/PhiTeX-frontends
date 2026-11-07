import { test } from "node:test";
import assert from "node:assert/strict";

// (the page's world, as created.ts sees it: a location, localStorage, fetch and XMLHttpRequest answering as Overleaf does)
const store = new Map<string, string>();
const g = globalThis as any;
g.window = globalThis;
g.location = new URL("https://www.overleaf.com/project");
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const NEW = "aaaaaaaaaaaaaaaaaaaaaaaa", COPY = "bbbbbbbbbbbbbbbbbbbbbbbb", SRC = "cccccccccccccccccccccccc", UP = "dddddddddddddddddddddddd";
g.fetch = async (input: string, init?: RequestInit) => {
  const path = new URL(input, "https://www.overleaf.com").pathname;
  const id = path === "/project/new" ? NEW : path === `/project/${SRC}/clone` ? COPY : path === "/project/new/upload" ? "eeeeeeeeeeeeeeeeeeeeeeee" : null;
  return new Response(JSON.stringify(init?.method === "POST" && id ? { project_id: id } : {}), { status: 200 });
};
class FakeXhr extends EventTarget {
  status = 0;
  responseType = "";
  responseText = "";
  url = "";
  open(_m: string, url: string) { this.url = url; }
  send() { this.status = 200; this.responseText = JSON.stringify({ success: true, project_id: UP }); this.dispatchEvent(new Event("load")); }
}
g.XMLHttpRequest = FakeXhr;

const { forget, own, pending, remember, watchCreated } = await import("../../apps/overleaf/src/folders/created.ts");

test("a new project, a copy and an upload are reported with their ids; the extension's own request is not", async () => {
  const made: [string, string | null][] = [];
  const stop = watchCreated((id, from) => made.push([id, from]));
  await fetch("/project/new", { method: "POST", body: "{}" });
  await fetch(`/project/${SRC}/clone`, { method: "POST", body: "{}" });
  await fetch(`/project/${SRC}/rename`, { method: "POST", body: "{}" });
  await fetch("/project/new", { method: "GET" });
  const mine = { method: "POST", body: "x" };
  own.add(mine);
  await fetch("/project/new/upload", mine);
  const x = new XMLHttpRequest();
  x.open("POST", "/project/new/upload");
  x.send();
  await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.deepEqual(made.sort(), [[NEW, null], [COPY, SRC], [UP, null]].sort());
});

test("pending: kept until forgotten, a day at most", () => {
  remember(NEW, "f1");
  remember(COPY, "f2");
  assert.deepEqual(pending().sort(), [[NEW, "f1"], [COPY, "f2"]].sort());
  forget([NEW]);
  assert.deepEqual(pending(), [[COPY, "f2"]]);
  store.set("phitex:folders-pending", JSON.stringify({ [COPY]: { folder: "f2", at: Date.now() - 2 * 864e5 } }));
  assert.deepEqual(pending(), []);
});
