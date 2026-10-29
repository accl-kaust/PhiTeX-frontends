// Shelf's hosts (shelf.ts HOSTS, as PhiTeX's shelf::HOSTS): the first that answers is the answer.
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

  // (an HTTP error from the first host: no other asked)
  assert.equal((await shelfFetch("h/x.pack")).status, 404);
  assert.deepEqual(asked, [first + "h/x.pack"]);

  // (the first unreachable: the second asked, and the first never again)
  down = new Set([first]);
  asked.length = 0;
  await shelfFetch("release.json");
  await shelfFetch("h/y.pack");
  assert.deepEqual(asked, [first + "release.json", second + "release.json", second + "h/y.pack"]);

  // (none reachable: fetch's error)
  down = new Set([first, second]);
  await assert.rejects(shelfFetch("h/z.pack"), TypeError);
});
