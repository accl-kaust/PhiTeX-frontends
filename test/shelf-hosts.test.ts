// Shelf's hosts (shelf.ts HOSTS, as PhiTeX's shelf::HOSTS): asked in the order
// a race of release.json decides, once a visit; any answer is the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setPlatform, type Platform } from "../common/src/platform.ts";
import { HOSTS } from "../common/src/shelf.ts";

const [first, second] = HOSTS;
let asked: string[] = [];
let down = new Set<string>();
setPlatform({
  fetch: async (url: string) => {
    asked.push(url);
    if ([...down].some((h) => url.startsWith(h))) throw new TypeError("Failed to fetch");
    return new Response("", { status: 404 });
  },
} as unknown as Platform);
// (a visit: shelf.ts anew, its order not yet decided)
let visits = 0;
const visit = async (): Promise<typeof import("../common/src/shelf.ts")> => import(`../common/src/shelf.ts?visit=${++visits}`);

test("every host reachable: HOSTS' order, an HTTP error the answer", async () => {
  const { shelfFetch } = await visit();
  asked = [];
  down = new Set();
  assert.equal((await shelfFetch("h/x.pack")).status, 404);
  assert.deepEqual(asked, [first + "release.json", second + "release.json", first + "h/x.pack"]);
});

test("the first unreachable: the second first for the whole visit, the first asked only in the race", async () => {
  const { shelfFetch } = await visit();
  asked = [];
  down = new Set([first]);
  await shelfFetch("h/x.pack");
  await shelfFetch("h/y.pack");
  assert.deepEqual(asked, [first + "release.json", second + "release.json", second + "h/x.pack", second + "h/y.pack"]);
});

test("a host lost after the race: the next asked; none reachable: fetch's error", async () => {
  const { shelfFetch } = await visit();
  down = new Set();
  await shelfFetch("release.json");
  asked = [];
  down = new Set([first]);
  assert.equal((await shelfFetch("h/z.pack")).status, 404);
  assert.deepEqual(asked, [first + "h/z.pack", second + "h/z.pack"]);
  down = new Set([first, second]);
  await assert.rejects(shelfFetch("h/z.pack"), TypeError);
});
