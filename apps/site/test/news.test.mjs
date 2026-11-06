import { test } from "node:test";
import assert from "node:assert/strict";
import { news } from "../scripts/news.mjs";

const LOG = `# Changelog

Intro.

## 1.61 (2027-01-02)
Faster edits
in XeLaTeX.

> advisory <1.61: 1.6 can write a wrong PDF after deleting a page; upgrade

- detail

## 1.6 (2026-11-02)
First alpha.

## Alpha: plain TeX and LaTeX

Milestone text.
`;

test("releases and advisories from CHANGELOG.md, milestones left out", () => {
  const n = news(LOG);
  assert.equal(n.schema, 1);
  assert.equal(n.latest, "1.61");
  assert.deepEqual(
    n.entries.map((e) => [e.kind, e.version ?? e.affects, e.summary]),
    [
      ["release", "1.61", "Faster edits in XeLaTeX."],
      ["advisory", "<1.61", "1.6 can write a wrong PDF after deleting a page; upgrade"],
      ["release", "1.6", "First alpha."],
    ],
  );
  assert.equal(n.entries[0].date, "2027-01-02");
});

test("no release yet: no latest, no entries", () => {
  assert.deepEqual(news("# Changelog\n\n## Alpha: plain TeX\n\nText.\n"), { schema: 1, latest: null, entries: [] });
});
