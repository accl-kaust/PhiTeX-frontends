// The hosts' keeping of the persisted graphs (common/src/wasm/graphs.ts): one
// a document, under its project's name; past the cap (graphs, bytes) the
// least recently used go first; the setting on by default, off dropping
// them all; and the core's graph event taken and kept under the open's
// document (common/src/wasm/core.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeyValue } from "../../common/src/platform.ts";
import { clearGraphs, graphStats, graphsOn, kvGraphs, setGraphsOn } from "../../common/src/wasm/graphs.ts";

/** A store in memory, as the platforms' (IndexedDB, VS Code's folder) keep it. */
function memoryKv(): KeyValue & { stores: Map<string, Map<string, unknown>> } {
  const stores = new Map<string, Map<string, unknown>>();
  const st = (s: string) => stores.get(s) ?? (stores.set(s, new Map()), stores.get(s)!);
  return {
    stores,
    get: async <T>(s: string, k: string) => st(s).get(k) as T | undefined,
    all: async <T>(s: string) => new Map(st(s)) as Map<string, T>,
    async write(ops) {
      for (const [s, k, v] of ops) v === undefined ? st(s).delete(k) : st(s).set(k, v);
    },
    async clear(ss) {
      for (const s of ss) st(s).clear();
    },
  };
}
const bytes = (n: number, x = 1) => new Uint8Array(n).fill(x);
const tick = () => new Promise((r) => setTimeout(r, 2));

test("a document's graph kept under its project, given back, dropped", async () => {
  const kv = memoryKv();
  let project = "p1";
  const g = kvGraphs(kv, () => project, { count: 4, bytes: 1000 });
  assert.equal(await g.get("main.tex"), null);
  await g.put("main.tex", bytes(10, 7));
  assert.deepEqual(await g.get("main.tex"), bytes(10, 7));
  project = "p2";
  assert.equal(await g.get("main.tex"), null, "another project's document of the same name: none");
  project = "p1";
  await g.drop("main.tex");
  assert.equal(await g.get("main.tex"), null);
  assert.deepEqual(await graphStats(kv), { entries: 0, bytes: 0, used: 0 });
});

test("past the cap, the least recently used go first; one larger than the cap is not kept", async () => {
  const kv = memoryKv();
  const g = kvGraphs(kv, () => "p", { count: 3, bytes: 100 });
  for (const d of ["a", "b", "c"]) (await g.put(d, bytes(20)), await tick());
  // (a used again: b is now the oldest)
  await g.get("a");
  await tick();
  await g.put("d", bytes(20));
  assert.equal(await g.get("b"), null, "the least recently used dropped for a fourth");
  for (const d of ["a", "c", "d"]) assert.ok(await g.get(d), `${d} kept`);
  await tick();
  // (by bytes: 60 kept, a 70 needs two of them gone)
  await g.put("e", bytes(70));
  const st = await graphStats(kv);
  assert.ok(st.bytes <= 100 && st.entries <= 3, JSON.stringify(st));
  assert.ok(await g.get("e"));
  await g.put("huge", bytes(101));
  assert.equal(await g.get("huge"), null, "larger than the cap alone: not kept");
  assert.ok(await g.get("e"), "and nothing dropped for it");
});

test("the setting: on by default; off drops every graph kept", async () => {
  const kv = memoryKv();
  const g = kvGraphs(kv, () => "p", { count: 4, bytes: 1000 });
  assert.equal(await g.on(), true);
  await g.put("main.tex", bytes(5));
  await setGraphsOn(kv, false);
  assert.equal(await graphsOn(kv), false);
  assert.equal(await g.on(), false);
  assert.equal(await g.get("main.tex"), null);
  await setGraphsOn(kv, true);
  assert.equal(await g.on(), true);
  await g.put("main.tex", bytes(5));
  await clearGraphs(kv);
  assert.equal(await g.get("main.tex"), null);
  assert.equal(await g.on(), true, "a clear leaves the setting");
});
