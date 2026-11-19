// Blame and Changes on Overleaf (the viewer's blame.ts and changes.ts draw
// them): no git here, so the project's history stands for it, exact to the
// character (olhistory.ts replays every change from the first). Each
// character of the editor's text is its writer's: the session (an update,
// named `v42`, no hashes to copy) and the person whose change typed it;
// text the history does not have yet (edits Overleaf has not saved to it)
// is not saved. Line, Word and Character detail are all made from those
// characters. An image's writer is the change that last added it. The
// labels are the tags; each author has Overleaf's own colour; the history
// is one lane of sessions; "What this version changed" is Changes' Diff of
// the session.

import { sourceFiles, type BlameCommit, type BlameData, type BlameFile, type BlameHost, type BlameOpts } from "./common/viewer/blame.ts";
import type { ChangeItem, ChangesHost, Pair } from "./common/viewer/changes.ts";
import type { Commit } from "./common/viewer/commits.ts";
import type { Glyph } from "./common/viewer/sync.ts";
import { FIRST, type OlLabel, type OlUpdate, type ProjectHistory, type Replay, userName } from "./olhistory.ts";

const BINARY = /\.(png|jpe?g|pdf|eps|ps|gif|bmp|tiff?|webp)$/i;

/** MD5 (RFC 1321) of a string's UTF-8 bytes, in hex (an id is ASCII: Overleaf's generateMD5Hash's). */
export function md5(s: string): string {
  const msg = new TextEncoder().encode(s);
  const n = ((msg.length + 8) >> 6) + 1;
  const w = new Uint32Array(n * 16);
  msg.forEach((b, i) => (w[i >> 2] |= b << ((i % 4) * 8)));
  w[msg.length >> 2] |= 0x80 << ((msg.length % 4) * 8);
  w[n * 16 - 2] = (msg.length * 8) >>> 0;
  w[n * 16 - 1] = Math.floor((msg.length * 8) / 2 ** 32);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let o = 0; o < w.length; o += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const f = r === 0 ? (b & c) | (~b & d) : r === 1 ? (d & b) | (~d & c) : r === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = r === 0 ? i : r === 1 ? (5 * i + 1) % 16 : r === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const t = (a + f + K[i] + w[o + g]) >>> 0;
      const sh = S[r * 4 + (i % 4)];
      [a, d, c] = [d, c, b];
      b = (b + ((t << sh) | (t >>> (32 - sh)))) >>> 0;
    }
    [a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
  }
  return [a0, b0, c0, d0].map((x) => Array.from({ length: 4 }, (_, j) => ((x >>> (8 * j)) & 255).toString(16).padStart(2, "0")).join("")).join("");
}

/**
 * The hue Overleaf gives a user, as its getHueForUserId does
 * (services/web/frontend/js/shared/utils/colors.ts): its own user 200, an
 * anonymous one 100; anyone else the first 8 hex digits of their id's MD5
 * modulo 320, a hue within 20 of 200 moved to the end (to 340 ± 20).
 */
export function overleafHue(userId: string | undefined, own: string | undefined): number {
  if (userId == null || userId === "" || userId === "anonymous-user") return 100;
  if (userId === own) return 200;
  let hue = parseInt(md5(userId).slice(0, 8), 16) % (360 - 20 * 2);
  if (hue > 200 - 20 && hue < 200 + 20) hue = hue - 200 + 360 - 20;
  return hue;
}

/**
 * Each character of `now` (the editor's text) matched in `hist` (the
 * history's latest): their common start and end, and between them a
 * longest common subsequence where it is small enough to work out (else,
 * the lines alike). A character of `now` with no match: -1, not saved to
 * the history yet.
 */
export function align(hist: string, now: string): Int32Array {
  const out = new Int32Array(now.length).fill(-1);
  let s = 0;
  while (s < hist.length && s < now.length && hist[s] === now[s]) (out[s] = s), s++;
  let ea = hist.length, eb = now.length;
  while (ea > s && eb > s && hist[ea - 1] === now[eb - 1]) out[--eb] = --ea;
  const n = ea - s, m = eb - s;
  if (!n || !m) return out;
  if (n * m <= 4_000_000) {
    const L = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = hist[s + i] === now[s + j] ? Math.min(65535, L[(i + 1) * (m + 1) + j + 1] + 1) : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (hist[s + i] === now[s + j]) out[s + j++] = s + i++;
      else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++;
      else j++;
    }
    return out;
  }
  // (too large a middle for characters: its lines alike, each line's characters with them)
  const lines = (t: string, from: number, to: number) => {
    const out: [number, string][] = [];
    let a = from;
    for (let i = from; i <= to; i++)
      if (i === to || t[i] === "\n") {
        out.push([a, t.slice(a, i + 1)]);
        a = i + 1;
      }
    return out;
  };
  const hl = lines(hist, s, ea), nl = lines(now, s, eb);
  const at = new Map<string, number[]>();
  hl.forEach(([a, l]) => (at.get(l) ?? at.set(l, []).get(l)!).push(a));
  for (const [b, l] of nl) {
    const a = at.get(l)?.shift();
    if (a !== undefined) for (let k = 0; k < l.length; k++) out[b + k] = a + k;
  }
  return out;
}

/** The UTF-16 offset of byte `b` of `t`'s UTF-8. */
export function charAt(t: string, b: number): number {
  let bytes = 0;
  for (let i = 0; i < t.length; i++) {
    if (bytes >= b) return i;
    const c = t.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
  }
  return t.length;
}

export interface OverleafChangesHost {
  history: ProjectHistory;
  /** The editor's text of a file (the session's), as the build reads it. */
  text(file: string): string | undefined;
  /** The project's main file and its files' names (the session's): the sources Blame works out. */
  main(): string | null;
  names(): string[];
  glyphs(k: number): Promise<Glyph[]>;
  goto(file: string, line: number): void;
  /** The user's own id (Overleaf's `ol-user_id`). */
  own?: string;
  /** The version the user had at their last visit. */
  lastVisit(): number | null;
}

/** A blame commit with the Overleaf user whose changes it names. */
type OlCommit = BlameCommit & { user?: string };

/** Blame and Changes' history from Overleaf's (olhistory.ts). */
export function overleafHistory(o: OverleafChangesHost): { blame: BlameHost; changes: Omit<ChangesHost, "diff"> } {
  const h = o.history;
  const color = (id: string | undefined) => `hsl(${overleafHue(id, o.own)}, 70%, 50%)`;
  const files = (u: OlUpdate) => {
    const p = u.pathnames ?? [];
    const ops = (u.project_ops ?? []).map((x) => x.add?.pathname ?? x.rename?.newPathname ?? x.remove?.pathname).filter((x): x is string => !!x);
    const all = [...new Set([...p, ...ops])];
    return all.length ? `${all.slice(0, 3).join(", ")}${all.length > 3 ? ` +${all.length - 3}` : ""}` : "the project";
  };
  const people = (u: OlUpdate) => (u.meta.users ?? []).map((w) => userName(w)).filter((n, i, a) => a.indexOf(n) === i);
  /** A session as the history's row: "Lina edited main.tex, refs.bib", its labels as tags. */
  const row = (u: OlUpdate, labels: { comment: string; version: number }[]): Commit => {
    const who = people(u);
    const names = who.length ? who.join(", ") : "Someone";
    const tags = [...(u.labels ?? []).map((l) => l.comment), ...labels.filter((l) => l.version === u.toV && !(u.labels ?? []).some((x) => x.comment === l.comment)).map((l) => l.comment)];
    const visit = o.lastVisit();
    const oldest = h.allUpdates && h.updates.at(-1) === u;
    return {
      id: `v${u.toV}`,
      short: `v${u.toV}`,
      parents: oldest ? [] : [`v${u.fromV}`],
      author: names,
      email: u.meta.users?.[0]?.email ?? "",
      time: u.meta.end_ts / 1000,
      subject: u.project_ops?.length && !u.pathnames?.length ? `${names} added, moved or deleted ${files(u)}` : `${names} edited ${files(u)}`,
      refs: tags.map((name) => ({ name, kind: "tag" as const })),
      ...(visit !== null && u.fromV < visit && visit <= u.toV ? { mark: "your last visit" } : {}),
    };
  };
  /** Blame's commit of change `i`: its session and its author (one session may hold several people's changes). */
  const commitOf = (u: OlUpdate | null, author: string | null, i: number): OlCommit => {
    if (!u || i === FIRST) return { id: "v0", short: "v0", author: "The first version", email: "", time: (h.updates.at(-1)?.meta.start_ts ?? Date.now()) / 1000, subject: "The project's first version" };
    const users = u.meta.users ?? [];
    const w = users.find((x) => x?.id === author) ?? h.users.get(author ?? "") ?? users[0] ?? null;
    const many = users.length > 1;
    return {
      id: many && w?.id ? `v${u.toV}~${w.id}` : `v${u.toV}`,
      short: `v${u.toV}`,
      author: userName(w),
      email: w?.email ?? "",
      time: u.meta.end_ts / 1000,
      subject: u.labels?.[0]?.comment ?? `Edited ${files(u)}`,
      parent: `v${u.fromV}`,
      rev: `v${u.toV}`,
      ...(w?.id ? { user: w.id } : {}),
    };
  };
  const userOf = new Map<string, string>();

  /** Each change index's commit index in `commits`, the sessions read as needed. */
  async function commitsFor(r: Replay, vs: Iterable<number>, commits: BlameCommit[], at: Map<string, number>): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const v of vs) {
      if (v < 0 && v !== FIRST) continue;
      const u = v === FIRST ? null : await h.updateOf(v);
      const c = commitOf(u, v === FIRST ? null : (r.authors[v] ?? null), v);
      let k = at.get(c.id);
      if (k === undefined) {
        k = commits.push(c) - 1;
        at.set(c.id, k);
        if (c.user) userOf.set(c.id, c.user);
      }
      out.set(v, k);
    }
    return out;
  }

  const blame: BlameHost = {
    words: { commit: "version", hashes: false },
    glyphs: (k) => o.glyphs(k),
    // (Blame works on the sources and the history: the main file and what it inputs, no page needed)
    sources: () => sourceFiles(o.main(), o.names(), (f) => o.text(f)),
    text: (f) => o.text(f),
    goto: (file, line) => o.goto(file, line),
    // (one lane: no branch to have been merged from)
    via: () => null,
    color: (c) => color(userOf.get(c.id)),
    async blame(names, opts?: BlameOpts): Promise<BlameData | string> {
      let r: Replay;
      const say = opts?.progress;
      const off = say ? h.onProgress(say) : null;
      try {
        r = await h.replay(true);
      } catch (e) {
        return `Couldn't read the project's history: ${(e as Error).message}`;
      } finally {
        off?.();
      }
      if (!r.version) return "No history yet: the project's edits show here once Overleaf has saved them";
      const moved = opts?.moved !== "mover";
      const skip = new Set(opts?.skip ?? []);
      const commits: BlameCommit[] = [];
      const at = new Map<string, number>();
      const out: Record<string, BlameFile> = {};
      for (const file of names) {
        if (out[file]) continue;
        if (BINARY.test(file)) {
          const i = r.lastChange(file);
          if (i === -1) out[file] = { error: "not in the history" };
          else out[file] = { last: (await commitsFor(r, [i], commits, at)).get(i)! };
          continue;
        }
        const first = r.runsNow(file, moved, () => false);
        const now = o.text(file) ?? first?.text;
        if (now === undefined) {
          out[file] = { error: "not in the history" };
          continue;
        }
        if (!first) {
          out[file] = { text: now, runs: now.length ? [[0, now.length, -1]] : [] };
          continue;
        }
        // (a skipped session's text goes back to whoever wrote it before: its sessions known first)
        const k0 = await commitsFor(r, new Set(first.runs.map((x) => x[2])), commits, at);
        const skipped = (v: number) => skip.size > 0 && k0.has(v) && (skip.has(commits[k0.get(v)!].id) || skip.has(commits[k0.get(v)!].id.replace(/~.*/, "")));
        const hist = skip.size ? r.runsNow(file, moved, skipped)! : first;
        const k = await commitsFor(r, new Set(hist.runs.map((x) => x[2])), commits, at);
        const per = new Int32Array(hist.text.length);
        for (const [a, b, v] of hist.runs) per.fill(k.get(v) ?? -1, a, b);
        const m = align(hist.text, now);
        const runs: [number, number, number][] = [];
        for (let i = 0; i < now.length; i++) {
          const c = m[i] < 0 ? -1 : per[m[i]];
          const l = runs.at(-1);
          if (l && l[2] === c && l[1] === i) l[1] = i + 1;
          else runs.push([i, i + 1, c]);
        }
        out[file] = { text: now, runs };
      }
      const labels = await h.labels().catch(() => []);
      return { commits, files: out, refs: labels.map((l) => ({ name: l.comment, kind: "tag", time: Date.parse(l.created_at) / 1000, id: `v${l.version}` })), now: Date.now() / 1000 };
    },
  };

  const sessionOf = (v: number) => h.updates.find((u) => u.fromV < v && v <= u.toV);
  const changes: Omit<ChangesHost, "diff"> = {
    words: { commit: "version", hashes: false },
    tree: { title: "Your edits now", detail: "The editor's text, with what Overleaf has not saved to its history yet" },
    lastVisit: () => {
      const v = o.lastVisit();
      const u = v === null ? undefined : sessionOf(v);
      return u ? `v${u.toV}` : null;
    },
    color: (_name, email) => {
      const w = [...h.users.values()].find((u) => u.email === email);
      return w?.id ? color(w.id) : null;
    },
    onProgress: (f) => void h.onProgress(f),
    async lastTag() {
      const l = (await h.labels().catch(() => [])).reduce<OlLabel | null>((a, x) => (!a || x.version > a.version ? x : a), null);
      return l ? { id: `v${l.version}`, name: l.comment } : null;
    },
    firstParentOf: (id) => {
      const u = h.updates.find((x) => `v${x.toV}` === id.replace(/~.*/, ""));
      return u ? `v${u.fromV}` : null;
    },
    async log(skip, limit) {
      try {
        // (a page of Overleaf's at a time: the graph shows each as it lands)
        if (h.updates.length < skip + limit && !h.allUpdates) await h.moreUpdates();
      } catch (e) {
        if (!h.updates.length) return `Couldn't read the project's history: ${(e as Error).message}`;
      }
      const labels = await h.labels().catch(() => []);
      return h.updates.slice(skip, skip + limit).map((u) => row(u, labels));
    },
    /**
     * Each change's author and time, exact: the characters it added
     * (between the two versions, or since From in the editor's text) by
     * the change that typed them, the newest; one that only deleted, by
     * the change that deleted its text.
     */
    async attribute(items: ChangeItem[], p: Pair, update, signal) {
      const r = await h.replay();
      if (signal.aborted) return;
      const ver = (id: string) => Number(id.replace(/^v/, "").replace(/~.*/, ""));
      const A = ver(p.from);
      const B = p.to === null ? r.version : ver(p.to);
      const byFile = new Map<string, ChangeItem[]>();
      for (const it of items) (byFile.get(it.file) ?? byFile.set(it.file, []).get(it.file)!).push(it);
      const name = async (v: number) => {
        const u = await h.updateOf(v);
        const id = r.authors[v];
        const w = (u?.meta.users ?? []).find((x) => x?.id === id) ?? h.users.get(id ?? "") ?? u?.meta.users?.[0] ?? null;
        return { name: userName(w), color: color(w?.id ?? undefined), time: r.times[v] / 1000, short: u ? `v${u.toV}` : undefined, via: null };
      };
      for (const [file, list] of byFile) {
        if (signal.aborted) return;
        // (the new text: the editor's, matched in the history's latest, or version To's)
        let who: Int32Array | null = null, text = "";
        if (p.to === null) {
          const now = o.text(file);
          // (moved text: the change that moved it, the list's change being the move)
          const hist = r.textAt(file, r.version, false);
          if (now !== undefined && hist) {
            const m = align(hist.text, now);
            who = Int32Array.from(m, (j) => (j < 0 ? -1 : hist.who[j]));
            text = now;
          }
        } else {
          const t = r.textAt(file, B, false);
          if (t) (who = t.who), (text = t.text);
        }
        const old = r.textAt(file, A);
        const dels = r.deletedAt(file, A, B);
        for (const it of list) {
          let best = -3, wip = 0, hist = 0;
          if (who && it.neu && it.at !== undefined) {
            const a = charAt(text, it.at), b = it.end !== undefined ? charAt(text, it.end) : a + it.neu.length;
            for (let i = a; i < Math.min(b, who.length); i++) {
              const v = who[i];
              if (v === -1) wip++;
              else if (v >= A && v < B) (hist++, v > best && (best = v));
            }
          }
          if (best < 0 && old && it.oldAt !== undefined) {
            const a = charAt(old.text, it.oldAt), b = it.oldEnd !== undefined ? charAt(old.text, it.oldEnd) : a + 1;
            for (let i = a; i < b; i++) {
              const v = dels.get(i);
              if (v !== undefined && v > best) best = v;
            }
          }
          // (latexdiff may pair a repeated word's older copy as the new one: the nearest change of the range beside it)
          if (best < 0 && !wip && who && it.neu && it.at !== undefined) {
            const a = charAt(text, it.at), b = it.end !== undefined ? charAt(text, it.end) : a + it.neu.length;
            for (let d = 1; d <= 64 && best < 0; d++)
              for (const i of [a - d, b - 1 + d]) {
                const v = i >= 0 && i < who.length ? who[i] : -3;
                if (v >= A && v < B && v > best) best = v;
              }
          }
          // (mostly typed since the history's last version: yours, not saved yet; else the newest change in it)
          if (wip && wip >= hist) (it.wip = true), (it.who = undefined);
          else if (best >= 0) (it.who = await name(best)), (it.wip = wip > 0);
        }
        update();
      }
    },
  };
  return { blame, changes };
}
