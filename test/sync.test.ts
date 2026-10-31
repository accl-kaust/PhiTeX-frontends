// Source ↔ page from glyph origins (sync.ts), and the UTF-8 ↔ UTF-16 offsets it uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boxes, from, glyphs, lineAt, nearest } from "../common/src/viewer/sync.ts";
import { byteOffset, charOffset } from "../common/src/viewer/edits.ts";

// (the origins as phitex-live answers them: base64 columns of little-endian words, one synthesized bit a glyph)
const b64 = (words: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(words)));
const u32 = (xs: number[]) => b64(new Uint32Array(xs).buffer);
const f32 = (xs: number[]) => b64(new Float32Array(xs).buffer);

// "main" (the job's name for main.tex) and a file not in the project; one glyph with no source (file 2^32-1).
const gs = glyphs(
  {
    files: ["main", "article.cls"],
    n: 5,
    file: u32([0, 0, 0, 1, 0xffffffff]),
    start: u32([10, 11, 20, 0, 0]),
    end: u32([11, 12, 21, 5, 0]),
    synth: u32([0b11000]),
    x: f32([100, 105, 100, 130, 140]),
    y: f32([200, 200, 212, 200, 200]),
  },
  (n) => (n === "main" ? "main.tex" : null),
);

test("names map to project paths; no source is null", () => {
  assert.deepEqual(gs.map((g) => g.file), ["main.tex", "main.tex", "main.tex", null, null]);
});

test("a double-click finds the nearest glyph with a source, a line apart weighing more", () => {
  assert.equal(nearest(gs, 106, 197)?.start, 11);
  assert.equal(nearest(gs, 101, 210)?.start, 20);
  // (nothing but glyphs without a source to the right: still the nearest that has one)
  assert.equal(nearest(gs, 141, 197)?.start, 11);
});

test("a source place finds its line's glyphs, on the printed line nearest it", () => {
  const hit = from(gs, "main.tex", 0, 30);
  assert.equal(hit.length, 3);
  assert.deepEqual(lineAt(hit, 11).map((g) => g.start), [10, 11]);
  assert.deepEqual(lineAt(hit, 25).map((g) => g.start), [20]);
  const [b] = boxes(lineAt(hit, 11), gs);
  assert.deepEqual(b, [99, 192, 12, 11]);
});

test("charOffset inverts byteOffset", () => {
  const s = "aé😀b\nx";
  for (let i = 0; i <= s.length; i++) if (!(i === 3)) assert.equal(charOffset(s, byteOffset(s, i)), i);
});
