import { test } from "node:test";
import assert from "node:assert/strict";
import { marksOf, withMarks, type Mark } from "../../apps/overleaf/src/marks.ts";
import type { Diagnostic } from "../../common/src/viewer/diagnostics.ts";

const undef: Diagnostic = {
  severity: "error",
  code: "tex",
  message: "Undefined control sequence",
  file: "main.tex",
  line: 7,
  problem: { severity: "error", code: "tex", message: "Undefined control sequence", notes: [], help: [], suggestions: [], file: "main.tex", line: 7, col: 5, excerpt: { text: "See \\foobar here.", start: 4, len: 7 }, context: [], included: [], box: null },
};

test("an error's mark is its command on its line; a problem with no command is none", () => {
  const overfull: Diagnostic = { severity: "warning", code: "tex", message: "Overfull \\hbox", file: "main.tex", line: 9 };
  assert.deepEqual(marksOf([undef, overfull], (ds) => [...ds]), [
    { file: "main.tex", line: 7, text: "See \\foobar here.", start: 4, len: 7, severity: "error", message: "Undefined control sequence" },
  ]);
});

test("the marks are the viewer's plain diagnostics'", () => {
  const plain = (ds: readonly Diagnostic[]) => ds.map((d) => ({ ...d, message: "Undefined command \\foobar" }));
  assert.equal(marksOf([undef], plain)[0].message, "Undefined command \\foobar");
  // (the viewer's own: an undefined command named, its culprit the command)
  assert.match(marksOf([undef])[0].message, /\\foobar|Undefined/);
});

test("each status tells the marks when they changed", () => {
  const told: Mark[][] = [];
  const statuses: unknown[] = [];
  const sink = withMarks({ status: (s: unknown) => void statuses.push(s) } as never, (m) => void told.push(m));
  sink.status({ pages: 1, diagnostics: [undef], main: "main.tex", file: null });
  sink.status({ pages: 1, diagnostics: [undef], main: "main.tex", file: null });
  sink.status({ pages: 1, diagnostics: [], main: "main.tex", file: null });
  assert.equal(statuses.length, 3);
  assert.deepEqual(told.map((m) => m.length), [1, 0]);
});
