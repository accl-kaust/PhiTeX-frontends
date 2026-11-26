import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreSession, localDate, sourceDate, type Core, type Open } from "../../common/src/wasm/core.ts";

test("the local date: seconds whose UTC fields are the local date and time", () => {
  const now = new Date(2026, 10, 26, 13, 45, 7);
  const d = new Date(localDate(now) * 1000);
  assert.deepEqual([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()], [2026, 10, 26, 13, 45, 7]);
});

test("SOURCE_DATE_EPOCH fixes the date; unset or not a number, none", () => {
  assert.equal(sourceDate({ SOURCE_DATE_EPOCH: "0" }), 0);
  assert.equal(sourceDate({ SOURCE_DATE_EPOCH: " 1700000000\n" }), 1700000000);
  assert.equal(sourceDate({}), undefined);
  assert.equal(sourceDate({ SOURCE_DATE_EPOCH: "soon" }), undefined);
});

/** A core that keeps what each open asked. */
function opening() {
  const opened: Open[] = [];
  const told: unknown[] = [];
  const core = {
    onEvent: () => {},
    tell: (e: unknown) => void told.push(e),
    graphs: { on: () => Promise.resolve(true) },
    graphFound: false,
    idle: () => Promise.resolve(),
    giveGraph: (_d: string, on: boolean) => Promise.resolve(on),
    open: (o: Open) => void opened.push(o),
    request: () => ({ ok: true, json: {} }),
    provide: () => 1,
    withdraw: () => {},
    givingOf: () => undefined,
  } as unknown as Core;
  return { core, opened, told };
}

test("each open gives the core the local date, or the host's", async () => {
  const a = opening();
  const before = localDate();
  await new CoreSession(a.core).request({ op: "open", main: "main.tex", files: { "main.tex": "x" } } as never);
  const after = localDate();
  const d = a.opened[0].date ?? NaN;
  assert.ok(d >= before && d <= after, `${d} not in [${before}, ${after}]`);
  const b = opening();
  await new CoreSession(b.core, { date: 0 }).request({ op: "open", main: "main.tex", files: { "main.tex": "x" } } as never);
  assert.equal(b.opened[0].date, 0);
});

test("an open tells, before its build, whether it starts from a kept graph (a real first build where none is)", async () => {
  const a = opening();
  await new CoreSession(a.core).request({ op: "open", main: "main.tex", files: { "main.tex": "x" } } as never);
  assert.deepEqual(a.told, [{ event: "opening", main: "main.tex", graphs: true, kept: false }]);
  const b = opening();
  (b.core as unknown as { graphFound: boolean }).graphFound = true;
  await new CoreSession(b.core).request({ op: "open", main: "main.tex", files: { "main.tex": "x" } } as never);
  assert.deepEqual(b.told, [{ event: "opening", main: "main.tex", graphs: true, kept: true }]);
});
