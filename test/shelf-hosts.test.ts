// Shelf's hosts (shelf.ts HOSTS, as PhiTeX's shelf::HOSTS): their order
// decided once a visit by a race (release.json asked of each at once, the
// first to answer first), then the first that answers is the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setPlatform, type Platform } from "../common/src/platform.ts";
import { HOSTS, shelfFetch } from "../common/src/shelf.ts";

test("a host that answers is the answer, an error included; one unreachable is skipped from then on", async () => {
  const asked: string[] = [];
  let down = new Set<string>();
  setPlatform({
    fetch: async (url: string) => {
      asked.push(url);
      if ([...down].some((h) => url.startsWith(h))) throw new TypeError("Failed to fetch");
      return new Response("", { status: 404 });
    },
  } as unknown as Platform);
  const [first, second] = HOSTS;

  // (the first unreachable: the race asks both once, the second answers
  // and comes first; its HTTP error is the answer, no other asked)
  down = new Set([first]);
  assert.equal((await shelfFetch("h/x.pack")).status, 404);
  assert.deepEqual(asked, [first + "release.json", second + "release.json", second + "h/x.pack"]);

  // (from then on the first is never asked: the race cost it one small request)
  asked.length = 0;
  await shelfFetch("release.json");
  await shelfFetch("h/y.pack");
  assert.deepEqual(asked, [second + "release.json", second + "h/y.pack"]);

  // (none reachable: every host tried in order, then fetch's error)
  down = new Set([first, second]);
  asked.length = 0;
  await assert.rejects(shelfFetch("h/z.pack"), TypeError);
  assert.deepEqual(asked, [second + "h/z.pack", first + "h/z.pack"]);
});
