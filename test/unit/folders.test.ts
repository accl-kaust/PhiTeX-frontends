import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, canMove, empty, invalid, invalidStatus, pathOf, STATUSES, tree, type Op, type State } from "../../apps/overleaf/src/folders/folders.ts";
import { Folders, memoryBackend } from "../../apps/overleaf/src/folders/sync.ts";

const run = (...ops: Op[]) => ops.reduce(apply, empty());
const base = () =>
  run(
    { op: "create", id: "r", parent: null, name: "Research" },
    { op: "create", id: "p", parent: "r", name: "PhD" },
    { op: "create", id: "t", parent: "p", name: "Thesis" },
    { op: "create", id: "c", parent: null, name: "Courses" },
    { op: "file", projects: ["p1", "p2"], folder: "t" },
    { op: "file", projects: ["p3"], folder: "c" },
  );

test("tree nests, sorts, and lists each folder's own projects", () => {
  const top = tree(base());
  assert.deepEqual(top.map((f) => f.name), ["Courses", "Research"]);
  const thesis = top[1].children[0].children[0];
  assert.equal(thesis.name, "Thesis");
  assert.deepEqual(thesis.projects, ["p1", "p2"]);
  assert.deepEqual(tree(base(), new Set(["p2"]))[1].children[0].children[0].projects, ["p2"]);
  assert.equal(pathOf(base(), "t"), "Research / PhD / Thesis");
});

test("names: not empty, unique among siblings (any case), a rename may keep its own", () => {
  const s = base();
  assert.match(invalid(s, null, " ")!, /empty/);
  assert.match(invalid(s, null, "research")!, /exists/);
  assert.equal(invalid(s, "r", "Courses"), null);
  assert.equal(invalid(s, null, "Research", "r"), null);
  assert.equal(apply(s, { op: "create", id: "x", parent: null, name: "COURSES" }), s);
});

test("moves: not into itself or below, not onto a same-named sibling", () => {
  const s = base();
  assert.equal(canMove(s, "r", "t"), false);
  assert.equal(canMove(s, "r", "r"), false);
  assert.equal(canMove(s, "t", null), true);
  assert.equal(apply(s, { op: "move", id: "r", parent: "t" }), s);
  assert.equal(apply(s, { op: "move", id: "t", parent: "c" }).folders.t.parent, "c");
});

test("delete takes the subtree; its projects end up in no folder", () => {
  const s = apply(base(), { op: "delete", id: "r" });
  assert.deepEqual(Object.keys(s.folders), ["c"]);
  assert.deepEqual(s.projects, { p3: "c" });
});

test("an op on a folder gone meanwhile changes nothing", () => {
  const s = apply(base(), { op: "delete", id: "p" });
  for (const o of [{ op: "create", id: "y", parent: "p", name: "Y" }, { op: "file", projects: ["p9"], folder: "t" }, { op: "rename", id: "t", name: "Z" }] as Op[])
    assert.equal(apply(s, o), s);
});

test("sync: saves batched, and replayed onto a copy another device saved meanwhile", async () => {
  const storage = memoryBackend();
  const a = new Folders(storage, 0);
  await a.load();
  a.do({ op: "create", id: "a", parent: null, name: "A" });
  a.do({ op: "file", projects: ["p1"], folder: "a" });
  assert.equal(a.state.folders.a.name, "A");
  await a.save();
  assert.equal(storage.data!.rev, 1);

  // (another device, from the same copy, saves first)
  const b = new Folders(storage, 0);
  await b.load();
  b.do({ op: "create", id: "b", parent: null, name: "B" });
  await b.save();
  a.do({ op: "file", projects: ["p2"], folder: "a" });
  await a.save();
  const s = storage.data as State;
  assert.equal(s.rev, 3);
  assert.deepEqual(Object.keys(s.folders).sort(), ["a", "b"]);
  assert.deepEqual(s.projects, { p1: "a", p2: "a" });
});

test("sync: a failed save keeps its changes, for the next", async () => {
  const storage = memoryBackend();
  const f = new Folders(storage, 0);
  await f.load();
  const write = storage.write;
  storage.write = async () => {
    throw new Error("offline");
  };
  f.do({ op: "create", id: "a", parent: null, name: "A" });
  await assert.rejects(f.save(), /offline/);
  assert.equal(f.state.folders.a.name, "A");
  storage.write = write;
  await f.save();
  assert.equal(storage.data!.folders.a.name, "A");
});

test("statuses: one per project, from the list; a status removed, removed from its projects", () => {
  let s = apply(base(), { op: "status", projects: ["p1", "p2"], status: "submitted" });
  s = apply(s, { op: "status", projects: ["p2"], status: "accepted" });
  assert.deepEqual(s.status, { p1: "submitted", p2: "accepted" });
  assert.equal(apply(s, { op: "status", projects: ["p1"], status: "nope" }), s);
  assert.deepEqual(apply(s, { op: "status", projects: ["p1"], status: null }).status, { p2: "accepted" });
  s = apply(s, { op: "removeStatus", id: "submitted" });
  assert.deepEqual(s.status, { p2: "accepted" });
  assert.equal(s.statuses!.length, STATUSES.length - 1);
  // (a folder deleted: its projects' statuses kept)
  assert.deepEqual(apply(s, { op: "delete", id: "r" }).status, { p2: "accepted" });
});

test("statuses: made, renamed, recoloured, reordered by the user; names unique", () => {
  let s = apply(base(), { op: "addStatus", status: { id: "x", name: " waiting on data ", color: "#F04343" } });
  assert.deepEqual(s.statuses!.at(-1), { id: "x", name: "waiting on data", color: "#F04343" });
  assert.equal(apply(s, { op: "addStatus", status: { id: "y", name: "IDEA", color: "#000000" } }), s);
  assert.match(invalidStatus(s, "Drafting")!, /exists/);
  assert.equal(invalidStatus(s, "drafting", "drafting"), null);
  s = apply(s, { op: "editStatus", id: "x", name: "blocked", color: "#434AF0" });
  assert.deepEqual(s.statuses!.at(-1), { id: "x", name: "blocked", color: "#434AF0" });
  assert.equal(apply(s, { op: "editStatus", id: "x", name: "idea" }), s);
  s = apply(s, { op: "moveStatus", id: "x", to: 0 });
  assert.deepEqual(s.statuses!.map((x) => x.id), ["x", "idea", "drafting", "submitted", "revising", "accepted"]);
  s = apply(s, { op: "moveStatus", id: "idea", to: 99 });
  assert.equal(s.statuses!.at(-1)!.id, "idea");
});

import { fuzzy } from "../../apps/overleaf/src/folders/fuzzy.ts";

test("fuzzy: words, starts, parts, letters in order, slips; accents and case ignored", () => {
  const hit = (q: string, name: string) => fuzzy(q, name);
  assert.equal(hit("thesis", "MS Thesis")!.spans.length, 1);
  assert.deepEqual(hit("thes", "MS Thesis")!.spans, [[3, 7]]);
  assert.ok(hit("thss", "MS Thesis"), "letters in order");
  assert.ok(hit("theisis", "MS Thesis"), "a slip");
  assert.ok(hit("reserach", "Research notes"), "a swap");
  assert.ok(hit("ecole", "École d'été"), "accents");
  assert.ok(hit("CGRA map", "A Survey of CGRA Mapping"), "every word");
  assert.equal(hit("cgra zebra", "A Survey of CGRA Mapping"), null, "a word nowhere");
  assert.equal(hit("xq", "Thesis"), null);
  // (better first: a whole word over a part, the name's start over elsewhere)
  assert.ok(hit("map", "Map of CGRAs")!.score > hit("map", "Remapping")!.score);
  assert.ok(hit("thesis", "Thesis")!.score > hit("thesis", "MS Thesis")!.score);
  // (a word only in the context: found, less)
  const inFolder = fuzzy("research survey", "A Survey of CGRA Mapping", "Research / Papers")!;
  assert.ok(inFolder && inFolder.score < fuzzy("mapping survey", "A Survey of CGRA Mapping")!.score);
  assert.deepEqual(inFolder.spans, [[2, 8]], "only the name's own words highlighted");
  // (spans in the name's own characters, accents and all)
  const e = hit("ete", "École d'été")!;
  assert.equal("École d'été".slice(e.spans[0][0], e.spans[0][1]), "été");
});

import { dateSpan, marks, matches, parse, suggest, type Item } from "../../apps/overleaf/src/folders/query.ts";

const NOW = new Date(2026, 9, 29, 12).getTime();
const item = (o: Partial<Item>): Item => ({ name: "Paper", path: "", folders: [], owner: "You", mine: true, tags: [], updated: NOW, ...o });

test("query: words and filters, aliases, negation, alternatives, quotes", () => {
  const q = parse('cgra owner:mohamed,"Krishnan Iyer" -#old status:drafting in:Research after:7d');
  assert.equal(q.words, "cgra");
  assert.deepEqual(q.filters.map((f) => [f.key, f.values, f.not]), [
    ["owner", ["mohamed", "Krishnan Iyer"], false],
    ["tag", ["old"], true],
    ["status", ["drafting"], false],
    ["in", ["Research"], false],
    ["after", ["7d"], false],
  ]);
  assert.deepEqual(parse("@me author:x by:y").filters.map((f) => f.key), ["owner", "owner", "owner"]);
  assert.equal(parse("weird:thing").words, "weird:thing", "an unknown key is a word");
});

test("query: filters hold or don't", () => {
  const theirs = item({ owner: "Mohamed Bouaziz", ownerEmail: "m.b@kaust.edu.sa", mine: false, tags: ["ACCL Paper"], folders: ["CGRA", "Research"], status: "drafting" });
  const m = (q: string, it: Item) => matches(parse(q), it, NOW) !== null;
  assert.ok(m("@mohamed", theirs) && m("owner:bouaziz", theirs) && m("@kaust", theirs));
  assert.ok(!m("@me", theirs) && m("@me", item({})) && m("-@me", theirs));
  assert.ok(m("#accl", theirs) && m('tag:"accl paper"', theirs) && !m("-#accl", theirs));
  assert.ok(m("in:research", theirs) && m("in:cgra", theirs) && !m("in:thesis", theirs));
  assert.ok(m("status:draft", theirs) && !m("status:accepted", theirs));
  assert.ok(m("is:shared", theirs) && !m("is:mine", theirs));
  assert.ok(m("@nobody,mohamed", theirs), "alternatives");
  // (dates: last modified)
  const old = item({ updated: new Date(2026, 0, 15).getTime() });
  assert.ok(m("before:2026-02", old) && !m("after:2026-02", old) && m("after:2026", old) && m("before:1m", old) && !m("after:7d", old));
  assert.ok(m("after:today", item({})) && !m("after:today", old));
  assert.deepEqual(dateSpan("2026-09", NOW), [new Date(2026, 8, 1).getTime(), new Date(2026, 9, 1).getTime()]);
  assert.equal(dateSpan("soon", NOW), null);
  // (words with filters: the name fuzzy, the context too)
  assert.ok(matches(parse("papr @mohamed"), theirs, NOW)!.spans.length === 1);
  assert.ok(m("research", item({ path: "Research / CGRA" })), "a word in the folder's path");
  assert.ok(m("bouaziz", theirs), "a word in the owner's name");
});

test("query: suggestions as you type", () => {
  const vocab = { owners: ["You", "Mohamed Bouaziz", "Krishnan Iyer Balasubramaniam"], tags: ["ACCL Paper", "SHARED"], statuses: ["idea", "drafting"], folders: ["Research", "MS Thesis"] };
  const s = (q: string, at = q.length) => suggest(q, at, vocab);
  assert.equal(s("").items[0].label, "owner:", "help when empty");
  assert.deepEqual(s("ow").items.map((i) => i.insert), ["owner:"]);
  assert.deepEqual(s("@mo").items.map((i) => i.insert), ['@"Mohamed Bouaziz"']);
  assert.deepEqual(suggest("@mo", 3, { ...vocab, owners: ["Samy Mounir", "Mohamed Bouaziz", "Amos Ito"] }).items.map((i) => i.label), ["Mohamed Bouaziz", "Samy Mounir", "Amos Ito"], "a name it begins, then a word it begins, then a part");
  assert.ok(s("@").items.some((i) => i.insert === "@me"));
  assert.deepEqual(s("cgra #ac").items.map((i) => i.insert), ['#"ACCL Paper"']);
  assert.equal(s("cgra #ac").start, 5);
  assert.deepEqual(s("in:th").items.map((i) => i.insert), ['in:"MS Thesis"']);
  assert.deepEqual(s("-tag:sh").items.map((i) => i.insert), ["-tag:SHARED"]);
  assert.ok(s("after:").items.some((i) => i.insert === "after:7d"));
  assert.deepEqual(s("tag:accl,sh").items.map((i) => i.insert), ["tag:accl,SHARED"]);
});

test("query: the filters' parts, to colour; words left alone", () => {
  const q = 'thesis -@mo #a,b in:"Split L" owner: nope';
  const got = marks(q).map((m) => [m.kind, q.slice(m.start, m.end)]);
  assert.deepEqual(got, [["not", "-"], ["key", "@"], ["value", "mo"], ["key", "#"], ["value", "a,b"], ["key", "in:"], ["value", '"Split L"'], ["key", "owner:"]]);
});
