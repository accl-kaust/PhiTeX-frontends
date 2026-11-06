// The search box's language: words, matched forgivingly against a
// project's name (fuzzy.ts), its folder path, owner and tags its context;
// and filters, every one of which must hold:
//
//   owner:mohamed  author: by:  @mohamed  @me    who owns it ("me"/"you": you)
//   tag:"ACCL Paper"  #accl                     an Overleaf tag of it
//   status:drafting                             its status
//   in:Research                                 under a folder of that name
//   after:7d  before:2026-09  after:today       last modified (a date, a
//                                               year, a month; today,
//                                               yesterday; 3d 2w 6m 1y ago)
//   is:mine  is:shared                          yours, or shared with you
//
// A filter's values separated by commas are alternatives (tag:a,b); a "-"
// before one negates it (-tag:old, -@me); quotes keep spaces in a value.
// Pure: no DOM. With it, what the box suggests as you type (filters, then
// their values: the owners, tags, statuses and folders there are).

import { fuzzy, type Match } from "./fuzzy.ts";

export type Key = "owner" | "tag" | "status" | "in" | "after" | "before" | "is";
export type Filter = { key: Key; values: string[]; not: boolean };
export type Query = { words: string; filters: Filter[] };

/** The keys as typed (aliases included). */
const KEYS: Record<string, Key> = { owner: "owner", author: "owner", by: "owner", tag: "tag", status: "status", in: "in", after: "after", before: "before", is: "is" };

/** What a project is, for the search. */
export type Item = {
  name: string;
  /** Its folder's path ("Research / CGRA"), "" if in none. */
  path: string;
  /** The names of the folders it is under, its own first. */
  folders: string[];
  /** "You", or its owner's name. */
  owner: string;
  ownerEmail?: string;
  mine: boolean;
  tags: string[];
  status?: string;
  /** Last modified, ms since the epoch. */
  updated: number;
};

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The query's tokens: [start, end) in it, and their text (a quoted part unquoted). */
function tokens(q: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < q.length) {
    if (/\s/.test(q[i])) {
      i++;
      continue;
    }
    const start = i;
    let text = "";
    let quoted = false;
    while (i < q.length && (quoted || !/\s/.test(q[i]))) {
      if (q[i] === '"') quoted = !quoted;
      else text += q[i];
      i++;
    }
    out.push({ start, end: i, text });
  }
  return out;
}

/** A token as a filter (`key:values`, `@owner`, `#tag`, any with "-" before), or null: a word. */
function asFilter(t: string): Filter | null {
  const not = t.startsWith("-") && t.length > 1;
  const s = not ? t.slice(1) : t;
  let key: Key | undefined;
  let value: string;
  if (s.startsWith("@")) (key = "owner"), (value = s.slice(1));
  else if (s.startsWith("#")) (key = "tag"), (value = s.slice(1));
  else {
    const m = /^([a-z]+):(.*)$/i.exec(s);
    key = m ? KEYS[m[1].toLowerCase()] : undefined;
    value = m ? m[2] : "";
  }
  if (!key) return null;
  return { key, values: value.split(",").map((v) => v.trim()).filter(Boolean), not };
}

/** A part of the query to colour: a filter's "-", its key (`owner:`, `@`, `#`), its value; a key with no value yet is still a key. */
export type Mark = { start: number; end: number; kind: "not" | "key" | "value" };

/** The query's filters, in parts, to colour as it is typed (words are left as they are). */
export function marks(q: string): Mark[] {
  const out: Mark[] = [];
  for (const t of tokens(q)) {
    if (!asFilter(t.text)) continue;
    let at = t.start;
    if (q[at] === "-") out.push({ start: at, end: ++at, kind: "not" });
    const key = /^[@#]/.test(q[at]) ? 1 : q.slice(at, t.end).indexOf(":") + 1;
    out.push({ start: at, end: at + key, kind: "key" });
    if (at + key < t.end) out.push({ start: at + key, end: t.end, kind: "value" });
  }
  return out;
}

export function parse(q: string): Query {
  const words: string[] = [];
  const filters: Filter[] = [];
  for (const t of tokens(q)) {
    const f = asFilter(t.text);
    if (f) {
      if (f.values.length) filters.push(f);
    } else words.push(t.text);
  }
  return { words: words.join(" "), filters };
}

const DAY = 86400000;

/** A date as typed, the span of time it names: [from, to) in ms; null if it isn't one. */
export function dateSpan(v: string, now: number): [number, number] | null {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const s = v.toLowerCase();
  if (s === "today") return [t0, t0 + DAY];
  if (s === "yesterday") return [t0 - DAY, t0];
  // (that long ago: 3d, 2w, 6m, 1y; the moment, now less that)
  const ago = /^(\d+)\s*([dwmy])$/.exec(s);
  if (ago) {
    const n = +ago[1];
    const d = new Date(now);
    if (ago[2] === "d") d.setDate(d.getDate() - n);
    if (ago[2] === "w") d.setDate(d.getDate() - 7 * n);
    if (ago[2] === "m") d.setMonth(d.getMonth() - n);
    if (ago[2] === "y") d.setFullYear(d.getFullYear() - n);
    return [d.getTime(), d.getTime()];
  }
  const ymd = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(s);
  if (!ymd) return null;
  const [y, m, d] = [+ymd[1], ymd[2] ? +ymd[2] - 1 : undefined, ymd[3] ? +ymd[3] : undefined];
  const from = new Date(y, m ?? 0, d ?? 1).getTime();
  const to = d !== undefined ? new Date(y, m!, d + 1).getTime() : m !== undefined ? new Date(y, m + 1, 1).getTime() : new Date(y + 1, 0, 1).getTime();
  return [from, to];
}

/** Whether `v` names `text`: a word of it starting so, or a part of it (case and accents ignored). */
const names = (v: string, text: string) => {
  const a = fold(v);
  const b = fold(text);
  return b === a || b.includes(a);
};

function holds(f: Filter, it: Item, now: number): boolean {
  const any = f.values.some((v) => {
    switch (f.key) {
      case "owner":
        return /^(me|you|mine)$/i.test(v) ? it.mine : !it.mine && (names(v, it.owner) || (!!it.ownerEmail && names(v, it.ownerEmail)));
      case "tag":
        return it.tags.some((t) => names(v, t));
      case "status":
        return !!it.status && names(v, it.status);
      case "in":
        return it.folders.some((f) => names(v, f));
      case "is":
        return /^mine$/i.test(v) ? it.mine : /^shared$/i.test(v) ? !it.mine : false;
      case "after":
      case "before": {
        const span = dateSpan(v, now);
        if (!span) return false;
        return f.key === "after" ? it.updated >= span[0] : it.updated < span[0];
      }
    }
  });
  return f.not ? !any : any;
}

/** How `q` matches `it`: null if a filter fails or a word is nowhere; else its name's matched spans and how well (filters alone: 0). */
export function matches(q: Query, it: Item, now = Date.now()): Match | null {
  if (!q.filters.every((f) => holds(f, it, now))) return null;
  if (!q.words.trim()) return { score: 0, spans: [] };
  return fuzzy(q.words, it.name, [it.path, it.owner, ...it.tags].join(" "));
}

/** The values a filter can take, as there are now. */
export type Vocabulary = { owners: string[]; tags: string[]; statuses: string[]; folders: string[] };

export type Suggestion = { label: string; detail?: string; insert: string };

const HELP: Suggestion[] = [
  { label: "owner:", detail: "who owns it (@name, @me)", insert: "owner:" },
  { label: "tag:", detail: "an Overleaf tag (#name)", insert: "tag:" },
  { label: "status:", detail: "its status", insert: "status:" },
  { label: "in:", detail: "under a folder", insert: "in:" },
  { label: "after:", detail: "modified since (7d, 2026-09, today)", insert: "after:" },
  { label: "before:", detail: "modified before", insert: "before:" },
  { label: "is:", detail: "mine or shared", insert: "is:" },
];

const quote = (v: string) => (/[\s,"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

/**
 * What to suggest with the caret at `caret` in `q`: the token under it
 * replaced ([start, end)) by one of `items`. A filter's value being typed:
 * the vocabulary's that fit, best first; a word that begins a filter's
 * name: that filter; nothing typed: every filter, as help.
 */
export function suggest(q: string, caret: number, vocab: Vocabulary): { start: number; end: number; items: Suggestion[] } {
  const at = tokens(q).find((t) => t.start <= caret && caret <= t.end);
  const start = at?.start ?? caret;
  const end = at?.end ?? caret;
  const text = at?.text ?? "";
  if (!text) return { start, end, items: q.trim() ? [] : HELP };
  const not = text.startsWith("-") ? "-" : "";
  const s = not ? text.slice(1) : text;
  const pick = (all: string[], typed: string, prefix: string, extra: Suggestion[] = []) => {
    const t = fold(typed);
    // (first those it begins, then those a word of which it begins, then the rest it is part of)
    const rank = (v: string) => (fold(v).startsWith(t) ? 0 : fold(v).split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(t)) ? 1 : 2);
    const fit = all.filter((v) => fold(v).includes(t)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return [...extra.filter((e) => fold(e.label).includes(t)), ...fit.slice(0, 8).map((v) => ({ label: v, insert: not + prefix + quote(v) }))];
  };
  let key: string | undefined;
  let value = "";
  let prefix = "";
  if (s.startsWith("@")) (key = "owner"), (value = s.slice(1)), (prefix = "@");
  else if (s.startsWith("#")) (key = "tag"), (value = s.slice(1)), (prefix = "#");
  else {
    const m = /^([a-z]+):(.*)$/i.exec(s);
    if (m && KEYS[m[1].toLowerCase()]) (key = KEYS[m[1].toLowerCase()]), (value = m[2].split(",").pop() ?? ""), (prefix = s.slice(0, s.length - value.length));
  }
  if (key === undefined) {
    // (a word that begins a filter's name: the filter)
    const k = fold(s);
    return { start, end, items: k.length >= 2 ? HELP.filter((h) => h.label.startsWith(k)).map((h) => ({ ...h, insert: not + h.insert })) : [] };
  }
  const items =
    key === "owner" ? pick(vocab.owners.filter((o) => o !== "You"), value, prefix, [{ label: "me", detail: "your own projects", insert: `${not}${prefix}me` }])
    : key === "tag" ? pick(vocab.tags, value, prefix)
    : key === "status" ? pick(vocab.statuses, value, prefix)
    : key === "in" ? pick(vocab.folders, value, prefix)
    : key === "is" ? pick(["mine", "shared"], value, prefix)
    : pick([], value, prefix, [
        { label: "today", insert: `${not}${prefix}today` },
        { label: "yesterday", insert: `${not}${prefix}yesterday` },
        { label: "7d", detail: "a week ago", insert: `${not}${prefix}7d` },
        { label: "1m", detail: "a month ago", insert: `${not}${prefix}1m` },
        { label: "1y", detail: "a year ago", insert: `${not}${prefix}1y` },
        { label: String(new Date().getFullYear()), detail: "this year", insert: `${not}${prefix}${new Date().getFullYear()}` },
      ]);
  // (what is typed already is no suggestion)
  return { start, end, items: items.filter((i) => i.insert !== text) };
}
