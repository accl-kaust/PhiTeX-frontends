// What the extensions store, versioned (common/src/format.ts): the rules,
// each store's, and the lock (test/unit/formats.lock.json) that fails a change
// of a stored shape made without a new format: the folders' State type, and
// the settings' keys (one gone is a rename or a removal: a step). A
// deliberate change: a new format, its step, a fixture of the old one
// (test/fixtures/formats/), then the lock written again (UPDATE_LOCK=1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { current, NewerFormat, upgrade } from "../../common/src/format.ts";
import { FORMAT, readState, STEPS } from "../../apps/overleaf/src/folders/folders.ts";
import { Folders, memoryBackend } from "../../apps/overleaf/src/folders/sync.ts";
import { FORMAT as SETTINGS_FORMAT, upgradeSettings } from "../../apps/overleaf/src/settings.ts";
import { DATABASES } from "../../common/src/platform.ts";

test("upgrade: an older format through each step, the newest as it is, a newer refused", () => {
  const steps = { 1: (d: any) => ({ ...d, b: d.a * 2 }), 2: ({ a, ...d }: any) => ({ ...d, c: a }) };
  assert.deepEqual(upgrade("x", { version: 1, a: 3 }, 3, steps), { version: 3, b: 6, c: 3 });
  assert.deepEqual(upgrade("x", { version: 3, b: 1 }, 3, steps), { version: 3, b: 1 });
  assert.throws(() => upgrade("x", { version: 4 }, 3, steps), (e) => e instanceof NewerFormat && e.found === 4 && e.reads === 3);
  assert.throws(() => upgrade("x", { a: 1 }, 3, steps), /no format version/);
  assert.throws(() => upgrade("x", { version: 1 }, 3, { 2: (d) => d }), /no step from format 1/);
});

test("caches: their format's content, any other none", () => {
  assert.deepEqual(current({ v: 2, data: [1] }, 2), [1]);
  assert.equal(current({ v: 1, data: [1] }, 2), null);
  assert.equal(current({ v: 3, data: [1] }, 2), null);
  assert.equal(current([1] as never, 2), null);
});

test("folders: every stored format read (a fixture of each, test/fixtures/formats/), the current one as it is", () => {
  const fixtures = readdirSync("test/fixtures/formats").filter((f) => /^folders-\d+\.json$/.test(f));
  assert.ok(fixtures.includes(`folders-${FORMAT}.json`), `a fixture of format ${FORMAT}`);
  for (const f of fixtures) {
    const { dataFolder: _, ...stored } = JSON.parse(readFileSync(`test/fixtures/formats/${f}`, "utf8"));
    const s = readState(stored);
    assert.equal(s.version, FORMAT, f);
    assert.ok(Object.keys(s.folders).length > 0 && Object.keys(s.projects).length > 0, f);
  }
  for (let n = 1; n < FORMAT; n++) assert.ok(STEPS[n], `a step from format ${n}`);
});

test("folders: a newer format neither shown nor written over", async () => {
  const newer = { version: FORMAT + 1, rev: 3, folders: { x: { name: "From the future", parent: null } }, projects: {} };
  const backend = { ...memoryBackend(), read: async () => readState(structuredClone(newer)), writes: 0, async write() { this.writes++; } };
  const f = new Folders(backend, 0);
  await assert.rejects(f.load(), NewerFormat);
  assert.deepEqual(f.state.folders, {});
  const errors: Error[] = [];
  f.onError = (e) => errors.push(e);
  f.do({ op: "create", id: "a", name: "A", parent: null });
  await f.save();
  assert.equal(backend.writes, 0);
  assert.ok(errors[0] instanceof NewerFormat);
});

test("folders: saved in the current format", async () => {
  const backend = memoryBackend();
  const f = new Folders(backend, 0);
  await f.load();
  f.do({ op: "create", id: "a", name: "A", parent: null });
  await f.save();
  assert.equal(backend.data?.version, FORMAT);
});

test("settings: no format yet is format 1, kept; a newer one left as it is; a step renames", () => {
  assert.deepEqual(upgradeSettings({ enabled: true }), { set: { enabled: true, format: SETTINGS_FORMAT }, remove: [] });
  assert.equal(upgradeSettings({ enabled: true, format: SETTINGS_FORMAT }), null);
  assert.equal(upgradeSettings({ enabled: true, format: SETTINGS_FORMAT + 1 }), null);
  const steps = { 1: ({ tipOff, ...s }: any) => ({ ...s, tipsOff: tipOff }) };
  assert.deepEqual(upgradeSettings({ tipOff: true, format: 1 }, steps, 2), { set: { tipsOff: true, format: 2 }, remove: ["tipOff"] });
});

/** The State type's declaration, comments and spacing aside: what folders.json holds. */
function stateShape(): string {
  const src = readFileSync("apps/overleaf/src/folders/folders.ts", "utf8");
  const decl = /export type State = \{[\s\S]*?\n\};/.exec(src)?.[0] ?? "";
  const status = /export type Status = [^\n]*/.exec(src)?.[0] ?? "";
  return (decl + status).replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
}

/** The settings' keys the extension reads or writes (chrome.storage.local, apps/overleaf/src/*.ts). */
function settingKeys(): string[] {
  const keys = new Set<string>();
  for (const f of readdirSync("apps/overleaf/src").filter((f) => f.endsWith(".ts"))) {
    const s = readFileSync(`apps/overleaf/src/${f}`, "utf8");
    for (const [, how, args] of s.matchAll(/chrome\.storage\.local\.(get|set|remove)\(([^)]*)\)/g)) {
      if (how === "set") for (const [, k] of args.matchAll(/(?:^\s*\{|,)\s*([A-Za-z]\w*)\s*:/g)) keys.add(k);
      else for (const [, k] of args.matchAll(/"([A-Za-z]\w*)"/g)) keys.add(k);
    }
  }
  return [...keys].sort();
}

test("the lock: a stored shape changed only with a new format", () => {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const now = {
    folders: { format: FORMAT, shape: hash(stateShape()) },
    settings: { format: SETTINGS_FORMAT, keys: settingKeys() },
    databases: Object.fromEntries(Object.entries(DATABASES).map(([k, d]) => [k, d.format])),
  };
  if (process.env.UPDATE_LOCK) writeFileSync("test/unit/formats.lock.json", JSON.stringify(now, null, 1) + "\n");
  const lock = JSON.parse(readFileSync("test/unit/formats.lock.json", "utf8"));
  const fix = "a new format and its step (and a fixture of the old one), then UPDATE_LOCK=1 node --test test/unit/formats.test.ts";
  assert.ok(now.folders.format > lock.folders.format || now.folders.shape === lock.folders.shape, `the folders' State changed in format ${FORMAT}: ${fix}`);
  const gone = lock.settings.keys.filter((k: string) => !now.settings.keys.includes(k));
  assert.ok(now.settings.format > lock.settings.format || !gone.length, `settings no longer used: ${gone.join(", ")} (a rename or a removal): ${fix}`);
  // (a new setting is no new format, an older extension ignoring it: the lock written again only)
  assert.deepEqual(now, lock, `the lock is behind: UPDATE_LOCK=1 node --test test/unit/formats.test.ts`);
});
