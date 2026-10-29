// A forgiving search of names (projects', folders'): the query's words each
// found in the name, the best way each is: a whole word, a word's start, a
// part of a word, its letters in order with gaps ("thss" in "thesis"), or
// a word with one slip (two for long ones: "theisis", "reserach"); case
// and accents ignored. A word found nowhere in the name may be found in
// the name's context (a project's folder path), scoring less. Pure: no
// DOM; the matched spans of the name returned, to be highlighted.

/** The name's spans the query matched ([start, end) in the name), and how well (higher, better). */
export type Match = { score: number; spans: [number, number][] };

/** `s` lowered and its accents dropped, each character's place in `s` kept. */
function fold(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; ) {
    const c = String.fromCodePoint(s.codePointAt(i)!);
    const n = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < n.length; k++) at.push(i);
    text += n;
    i += c.length;
  }
  at.push(s.length);
  return { text, at };
}

/** The edits (insert, delete, change, swap two neighbours) between `a` and `b`, up to `max` (more: max + 1). */
function slips(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** One query word in the folded name: its best match, or null. */
function word(q: string, name: string): { score: number; spans: [number, number][] } | null {
  const words = [...name.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ text: m[0], start: m.index! }));
  // (a whole word, a word's start, inside a word)
  let best: { score: number; spans: [number, number][] } | null = null;
  for (const w of words) {
    if (w.text === q) return { score: 4, spans: [[w.start, w.start + q.length]] };
    if (w.text.startsWith(q)) best = best && best.score >= 3 ? best : { score: 3, spans: [[w.start, w.start + q.length]] };
  }
  if (best) return best;
  const i = name.indexOf(q);
  if (i >= 0) return { score: 2, spans: [[i, i + q.length]] };
  // (a word with a slip or two: the name's word, or as much of it as the query is long)
  if (q.length >= 4) {
    const max = q.length >= 8 ? 2 : 1;
    for (const w of words) {
      for (const len of [w.text.length, q.length, q.length - 1, q.length + 1]) {
        if (len < 3 || len > w.text.length) continue;
        if (slips(q, w.text.slice(0, len), max) <= max) return { score: 1.5, spans: [[w.start, w.start + len]] };
      }
    }
  }
  // (its letters in order, not too far apart: within one word, or across the name's start of words)
  const spans: [number, number][] = [];
  let at = 0;
  for (const c of q) {
    const k = name.indexOf(c, at);
    if (k < 0) return null;
    if (spans.length && spans[spans.length - 1][1] === k) spans[spans.length - 1][1] = k + 1;
    else spans.push([k, k + 1]);
    at = k + 1;
  }
  const spread = spans[spans.length - 1][1] - spans[0][0];
  if (q.length < 3 || spread > q.length * 3) return null;
  return { score: 1 - spans.length / (q.length + 1) / 2, spans };
}

/** How `query` matches `name` (and, for words not in it, `context`: a folder's path, say); null: it doesn't. */
export function fuzzy(query: string, name: string, context = ""): Match | null {
  const words = fold(query).text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const f = fold(name);
  const ctx = fold(context).text;
  let score = 0;
  const spans: [number, number][] = [];
  for (const q of words) {
    const m = word(q, f.text);
    if (m) {
      score += m.score;
      for (const [a, b] of m.spans) spans.push([f.at[a], f.at[b]]);
      continue;
    }
    const c = word(q, ctx);
    if (!c) return null;
    score += c.score / 4;
  }
  // (the whole query at the name's start, first)
  if (f.text.startsWith(words.join(" "))) score += 1;
  spans.sort((a, b) => a[0] - b[0]);
  return { score, spans };
}
