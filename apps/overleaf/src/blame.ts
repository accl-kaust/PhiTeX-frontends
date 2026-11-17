// Blame on Overleaf (the viewer's blame.ts draws it): no git here, so the
// project's history stands for it, read as Overleaf's own History view reads
// it (same origin, the user's own session): a file's diff from the first
// version to the last marks each inserted run with who made it and when, a
// line taking its newest insert (historyBlame); the editor's lines the last
// version lacks (edits not flushed to the history yet) are not committed.
// A version is an update, named `v42` (no hashes to copy); an image's last
// change is the newest update that touched it; the labels are the tags for
// "changed since"; each author has Overleaf's own colour for them; "Compare
// with before this version" is the toolbar's Compare against the update's
// first version.

import { historyBlame, matchLines, type BlameCommit, type BlameData, type BlameFile, type BlameHost, type HistoryPart } from "./common/viewer/blame.ts";
import type { Glyph } from "./common/viewer/sync.ts";

interface User {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

interface Update {
  fromV: number;
  toV: number;
  meta: { users?: User[]; start_ts: number; end_ts: number };
  labels?: { comment: string }[];
  pathnames?: string[];
  project_ops?: { add?: { pathname?: string }; rename?: { newPathname?: string } }[];
}

interface Label {
  comment: string;
  version: number;
  created_at: string;
}

const name = (u: User | undefined) => (u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "someone" : "someone");

const BINARY = /\.(png|jpe?g|pdf|eps|ps|gif|bmp|tiff?|webp)$/i;

/** CRC-32 (IEEE) of a string's UTF-8 bytes, signed as Overleaf's colours take it. */
function crc32(s: string): number {
  let c = ~0;
  for (const b of new TextEncoder().encode(s)) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c | 0;
}

/**
 * The hue Overleaf gives a user (its editor's colours, getHueForUserId): its
 * own user 200, an anonymous one 100, anyone else a hash of their id, kept
 * clear of the own user's hue.
 */
export function overleafHue(userId: string | undefined, own: string | undefined): number {
  if (!userId || userId === "anonymous-user") return 100;
  if (userId === own) return 200;
  let hue = Math.abs(crc32(userId)) % 360;
  if (hue > 180 && hue < 220) hue -= 40;
  return hue;
}

export interface OverleafBlameHost {
  /** The project's base (`/project/<id>`). */
  base(): string;
  fetcher: typeof fetch;
  /** The editor's text of a file (the session's), as the build reads it. */
  text(file: string): string | undefined;
  glyphs(k: number): Promise<Glyph[]>;
  goto(file: string, line: number): void;
  /** Compare against version `v` (the toolbar's Compare), named `title`, `when`. */
  compare?(v: number, title: string, when: string): void;
  /** The user's own id (Overleaf's `ol-user_id`). */
  own?: string;
}

/** Blame from Overleaf's history. */
export function overleafBlame(o: OverleafBlameHost): BlameHost {
  const users = new Map<string, string>();
  const updates = new Map<string, Update>();
  let latest = 0;
  // (each answer kept a minute: Blame asks again after every build while it is on, and the
  // history moves only when Overleaf flushes the edits; the editor's text is matched anew each time)
  const kept = new Map<string, { at: number; v: Promise<unknown> }>();
  const get = <T>(u: string): Promise<T> => {
    const k = kept.get(u);
    if (k && Date.now() - k.at < 60_000) return k.v as Promise<T>;
    const v = (async () => {
      const r = await o.fetcher(u, { credentials: "include" });
      if (!r.ok) throw new Error(`history: ${r.status}`);
      return (await r.json()) as T;
    })();
    kept.set(u, { at: Date.now(), v });
    v.catch(() => kept.delete(u));
    return v;
  };
  /** The updates, newest first (up to 600, a page of 100 at a time). */
  const history = async (): Promise<Update[]> => {
    const out: Update[] = [];
    let before: number | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await get<{ updates: Update[]; nextBeforeTimestamp?: number }>(`${o.base()}/updates?min_count=100${before ? `&before=${before}` : ""}`);
      out.push(...page.updates);
      if (!page.nextBeforeTimestamp) break;
      before = page.nextBeforeTimestamp;
    }
    return out;
  };
  const commitOf = (u: Update, who?: User): BlameCommit => {
    const id = `v${u.toV}`;
    const w = who ?? u.meta.users?.[0];
    updates.set(id, u);
    if (w?.id) users.set(id, w.id);
    const files = u.pathnames ?? [];
    const subject = u.labels?.[0]?.comment ?? (files.length ? `Edited ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}` : "Files added, moved or deleted");
    return { id, short: id, author: name(w), email: w?.email ?? "", time: u.meta.end_ts / 1000, subject };
  };
  return {
    words: { commit: "version", hashes: false },
    glyphs: (k) => o.glyphs(k),
    goto: (file, line) => o.goto(file, line),
    compare: o.compare
      ? (c) => {
          const u = c ? updates.get(c.id) : undefined;
          if (c && u) o.compare!(u.fromV, `Before ${c.short}`, c.subject);
          else o.compare!(latest, "The last version", "against your edits");
        }
      : undefined,
    color: (c) => {
      const id = users.get(c.id);
      return id || !c.email ? `hsl(${overleafHue(id, o.own)}, 70%, 50%)` : null;
    },
    async blame(files): Promise<BlameData | string> {
      let ups: Update[], labels: Label[];
      try {
        [ups, labels] = await Promise.all([history(), get<Label[]>(`${o.base()}/labels`).catch(() => [] as Label[])]);
      } catch (e) {
        return `Couldn't read the project's history: ${(e as Error).message}`;
      }
      if (!ups.length) return "No history yet: the project's edits show here once Overleaf has saved them";
      latest = ups[0].toV;
      const commits: BlameCommit[] = [];
      const at = new Map<string, number>();
      const index = (c: BlameCommit) => {
        let k = at.get(c.id);
        if (k === undefined) (k = commits.push(c) - 1), at.set(c.id, k);
        return k;
      };
      // (an insert's meta: the update it was made in, by its time and author)
      const updateOf = (meta: NonNullable<HistoryPart["meta"]>): BlameCommit => {
        const t = meta.end_ts ?? meta.start_ts ?? 0;
        const who = meta.users?.[0];
        const u = ups.find((x) => x.meta.start_ts <= t && t <= x.meta.end_ts && (!who?.id || !x.meta.users?.length || x.meta.users.some((y) => y.id === who.id))) ?? ups.reduce((a, b) => (Math.abs(b.meta.end_ts - t) < Math.abs(a.meta.end_ts - t) ? b : a));
        return commitOf(u, who);
      };
      const oldest = ups.at(-1)!;
      const first: BlameCommit = { id: `v${oldest.fromV}`, short: `v${oldest.fromV}`, author: name(oldest.meta.users?.[0]), email: oldest.meta.users?.[0]?.email ?? "", time: oldest.meta.start_ts / 1000, subject: "The project's first version" };
      // (the newest update that changed, added or renamed a file to `file`)
      const touched = (file: string) => {
        const is = (p?: string) => p?.replace(/^\//, "") === file;
        return ups.find((x) => x.pathnames?.includes(file) || x.project_ops?.some((op) => is(op.add?.pathname) || is(op.rename?.newPathname)));
      };
      const out: Record<string, BlameFile> = {};
      for (const file of files) {
        if (out[file]) continue;
        if (BINARY.test(file)) {
          // (a name no update knows: no such file, one of the names an image may have)
          const u = touched(file);
          out[file] = u ? { last: index(commitOf(u)) } : { error: "not in the history" };
          continue;
        }
        const now = o.text(file);
        try {
          const d = await get<{ diff: HistoryPart[] | { binary: true } }>(`${o.base()}/diff?pathname=${encodeURIComponent(file)}&from=${oldest.fromV}&to=${latest}`);
          if (!Array.isArray(d.diff)) {
            const u = touched(file);
            out[file] = { last: u ? index(commitOf(u)) : index(first) };
            continue;
          }
          const h = historyBlame(d.diff, first, updateOf);
          const text = now ?? h.text;
          const m = matchLines(h.text.replace(/\n$/, "").split("\n"), text.replace(/\n$/, "").split("\n"));
          const n = text ? text.replace(/\n$/, "").split("\n").length : 0;
          out[file] = { text, lines: Array.from({ length: n }, (_, i) => (m.has(i) ? index(h.commits[h.lines[m.get(i)!]]) : -1)) };
        } catch {
          out[file] = now === undefined ? { error: "not in the history" } : { text: now, lines: now.replace(/\n$/, "").split("\n").map(() => -1) };
        }
      }
      return { commits, files: out, refs: labels.map((l) => ({ name: l.comment, kind: "tag", time: Date.parse(l.created_at) / 1000 })), now: Date.now() / 1000 };
    },
  };
}
