// The core's memory size, chosen once at its start (common/src/wasm/threads.ts,
// core/src/heap.rs): 4 GiB, else 3, else the 2 it starts with; then sealed,
// so a document that outgrows it stops and says the size it got.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PAGES_INITIAL, PAGES_MAX, SIZE_TRIES, chooseSize, gib, outgrew, outgrownMessage } from "../common/src/wasm/threads.ts";
import { Core } from "../common/src/wasm/core.ts";

/** A memory that may grow to `limit` pages (the renderer's data limit): a growth past it changes nothing, as memory.grow's refusal. */
function memory(limit: number) {
  const m = { pages: PAGES_INITIAL, asked: [] as number[] };
  const grow = (p: number) => {
    m.asked.push(p);
    // (the allocator's sbrk stops a page or two short of the size asked)
    if (p <= limit) m.pages = Math.max(m.pages, p - 2);
    return m.pages;
  };
  return { m, grow };
}

test("the size is 4 GiB, else 3, else 2, asked in that order", async () => {
  assert.deepEqual(SIZE_TRIES, [65535, 49152, 32768]);
  for (const [limit, want, asked] of [
    [PAGES_MAX, PAGES_MAX, [65535]],
    [60000, 49152, [65535, 49152]],
    [40000, PAGES_INITIAL, [65535, 49152, 32768]],
    [PAGES_INITIAL, PAGES_INITIAL, [65535, 49152, 32768]],
  ] as const) {
    const { m, grow } = memory(limit);
    assert.equal(await chooseSize(grow), want, `limit ${limit}`);
    assert.deepEqual(m.asked, asked, `limit ${limit}`);
    // (a refused try grew nothing: no memory lost to it)
    assert.equal(m.pages, want === PAGES_INITIAL ? PAGES_INITIAL : want - 2);
  }
});

test("while another core's memory is being freed, 4 GiB is asked again before a smaller size is taken", async () => {
  let limit = 49152;
  const { m, grow } = memory(Infinity);
  const g = (p: number) => (p <= limit ? grow(p) : (m.asked.push(p), m.pages));
  let waits = 0;
  // (freed after the third wait: the reload's core gets its 4 GiB)
  const got = await chooseSize(g, () => true, async () => void (++waits === 3 && (limit = PAGES_MAX)));
  assert.equal(got, PAGES_MAX);
  assert.equal(waits, 3);
  // (never freed while asked: 3 once the window ends)
  limit = 49152;
  let left = 2;
  const { m: m2, grow: grow2 } = memory(49152);
  assert.equal(await chooseSize(grow2, () => left-- > 0, async () => undefined), 49152);
  assert.deepEqual(m2.asked, [65535, 65535, 65535, 49152]);
});

test("a document that outgrows its size is told the size it got and what to close", () => {
  assert.equal(gib(PAGES_MAX), 4);
  assert.equal(gib(49152), 3);
  assert.equal(gib(PAGES_INITIAL), 2);
  assert.ok(outgrew("memory allocation of 496144 bytes failed\n"));
  assert.ok(!outgrew("panicked at src/lib.rs: index out of bounds"));
  const two = outgrownMessage(PAGES_INITIAL);
  assert.match(two, /more than the 2 GiB of memory PhiTeX's engine got in this tab/);
  assert.match(two, /other Overleaf tabs showing PhiTeX/);
  assert.match(two, /Close them/);
  assert.match(outgrownMessage(49152), /3 GiB/);
  const four = outgrownMessage(PAGES_MAX);
  assert.match(four, /4 GiB/);
  assert.doesNotMatch(four, /other Overleaf tabs/);
});

// The real core (built by scripts/build/build.sh): its size chosen on this
// thread, the allocator's heap grown past the link's 2 GiB into it, and
// nothing grown once sealed.
const wasm = new URL("../target/core/wasm32-wasip1-threads/release/core.wasm", import.meta.url);
test("the core's heap grows to the size chosen, and never past it", { skip: !existsSync(wasm) && "no core.wasm built" }, async () => {
  const core = await Core.start(await WebAssembly.compile(await readFile(wasm)), { spawn: () => undefined, resolve: async () => null });
  // (Node limits nothing: the largest)
  assert.equal(core.pages, PAGES_MAX);
  const x = (core as unknown as { x: { ph_alloc(n: number): number; ph_grow(p: number): number; memory?: WebAssembly.Memory } }).x;
  const mem = (core as unknown as { memory: WebAssembly.Memory }).memory;
  const size = mem.buffer.byteLength;
  assert.ok(size >= (PAGES_MAX - 4) * 65536, `grown: ${size}`);
  // (the allocator hands out the grown pages: blocks past 2 GiB, as far as the memory goes)
  let top = 0, n = 0;
  for (;;) {
    const p = x.ph_alloc(256 << 20) >>> 0;
    if (!p) break;
    top = Math.max(top, p + (256 << 20));
    n++;
  }
  while (x.ph_alloc(1 << 20) >>> 0) n++;
  assert.ok(top > 2 ** 31 && top <= size, `blocks to ${top} of ${size} (${n} blocks)`);
  // (sealed: a block that does not fit is refused, the memory as it was)
  assert.equal(x.ph_alloc(64 << 20) >>> 0, 0);
  assert.equal(x.ph_grow(PAGES_MAX) >>> 0, size / 65536);
  assert.equal(mem.buffer.byteLength, size);
  core.end();
});

// (sealed at 3 GiB, as a second tab's core may be: the allocator's growth
// refused past it, though the memory's maximum is 4 GiB; with libc's own
// sbrk the memory would grow on to its maximum under the threads)
test("a core sealed at 3 GiB never grows past it", { skip: !existsSync(wasm) && "no core.wasm built" }, async () => {
  const { imports, newMemory } = await import("../common/src/wasm/threads.ts");
  const memory = newMemory();
  const d = { module: await WebAssembly.compile(await readFile(wasm)), memory, ids: new SharedArrayBuffer(4), channel: "", env: [] };
  const inst = new WebAssembly.Instance(d.module, imports(d, () => undefined, () => undefined));
  const x = inst.exports as unknown as { _initialize(): void; ph_alloc(n: number): number; ph_grow(p: number): number; ph_seal(): void };
  x._initialize();
  assert.equal(memory.buffer.byteLength, PAGES_INITIAL * 65536, "made at 2 GiB");
  const got = x.ph_grow(49152) >>> 0;
  assert.ok(got >= 49152 - 4 && got <= 49152, `grown to ${got} pages`);
  x.ph_seal();
  let n = 0, top = 0;
  for (const b of [16 << 20, 1 << 16]) for (let p; (p = x.ph_alloc(b) >>> 0); n += b) top = Math.max(top, p + b);
  assert.equal(memory.buffer.byteLength, got * 65536, `${n} bytes in blocks, the memory as sealed`);
  assert.ok(top > 2.9 * 2 ** 30, `the grown GiB handed out: blocks to ${top}`);
});
