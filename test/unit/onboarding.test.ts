import { test } from "node:test";
import assert from "node:assert/strict";
import { installWrites, isNewFor, newsNow, tipsNow } from "../../apps/overleaf/src/onboarding.ts";
import type { News } from "../../apps/overleaf/src/news.ts";

const news: News[] = ["1.0.4", "1.0.3", "1.0.2"].map((version) => ({ version, date: "", title: version, items: [] }));

test("a fresh install: its notes count as seen, it is installed at this version", () => {
  assert.deepEqual(installWrites("install", "1.0.4", undefined, {}), { newsSeen: "1.0.4", installed: "1.0.4" });
  // (an update keeps what was seen; one from before What's new counts the version it came from)
  assert.deepEqual(installWrites("update", "1.0.4", "1.0.2", { newsSeen: "1.0.2" }), {});
  assert.deepEqual(installWrites("update", "1.0.4", "1.0.2", {}), { newsSeen: "1.0.2" });
});

test("What's new: none with no notes seen at all (a fresh install), the newer ones after an update", () => {
  const fresh = newsNow({}, "1.0.4", news);
  assert.deepEqual(fresh.items, []);
  assert.deepEqual(fresh.write, { newsSeen: "1.0.4", installed: "1.0.4" });
  assert.deepEqual(newsNow({ newsSeen: null }, "1.0.4", news).items, []);
  const upd = newsNow({ newsSeen: "1.0.2" }, "1.0.4", news);
  assert.deepEqual(upd.items.map((n) => n.version), ["1.0.4", "1.0.3"]);
  assert.equal(upd.write, null);
  assert.deepEqual(newsNow({ newsSeen: "1.0.4" }, "1.0.4", news).items, []);
});

const TIPS = [{ id: "changes", since: "1.0.4" }, { id: "timing" }, { id: "download" }, { id: "dark" }];
const all = () => true;

test("nothing is New to a fresh install", () => {
  assert.equal(isNewFor(TIPS[0], "1.0.4"), false);
  assert.equal(isNewFor(TIPS[0], "1.0.3"), true);
  // (installed before the record began: an old user)
  assert.equal(isNewFor(TIPS[0], null), true);
  assert.equal(isNewFor(TIPS[1], null), false);
  // (no "New" row for a fresh install, after any What's new)
  assert.deepEqual(tipsNow(TIPS, "news", { seen: [], installed: "1.0.4", newsBefore: "1.0.4" }, all), []);
});

test("after What's new: the tips of what it announced, not seen yet", () => {
  assert.deepEqual(tipsNow(TIPS, "news", { seen: [], installed: "1.0.1", newsBefore: "1.0.3" }, all).map((t) => t.id), ["changes"]);
  assert.deepEqual(tipsNow(TIPS, "news", { seen: ["changes"], installed: "1.0.1", newsBefore: "1.0.3" }, all), []);
  // (notes already past the feature's version: not announced now)
  assert.deepEqual(tipsNow(TIPS, "news", { seen: [], installed: "1.0.1", newsBefore: "1.0.4" }, all), []);
  // (What's new asked for again: every new one, seen or not)
  assert.deepEqual(tipsNow(TIPS, "news", { seen: ["changes"], installed: "1.0.1", newsBefore: "1.0.4", all: true }, all).map((t) => t.id), ["changes"]);
});

test("one tip a visit, skipping those whose control is hidden at this width", () => {
  assert.deepEqual(tipsNow(TIPS, "one", { seen: ["changes"] }, all).map((t) => t.id), ["timing"]);
  assert.deepEqual(tipsNow(TIPS, "one", { seen: ["changes"] }, (t) => t.id !== "timing").map((t) => t.id), ["download"]);
  assert.deepEqual(tipsNow(TIPS, "one", { seen: TIPS.map((t) => t.id) }, all), []);
});
