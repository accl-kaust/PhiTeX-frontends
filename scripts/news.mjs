// news.json from PhiTeX's CHANGELOG.md (PhiTeX's docs/spec-distribution.md §4):
// what `phitex`'s opt-in update check and the editor extensions read.
//
//   node scripts/news.mjs <CHANGELOG.md path or URL> <out.json>
//
// A release's entry in CHANGELOG.md is a `## <version> (<YYYY-MM-DD>)`
// heading; its first paragraph is the summary. A line `> advisory <range>:
// <text>` anywhere in an entry is an advisory for the versions in the range
// (`<1.618`: every version before 1.618). Headings that name no version
// (the milestones before 1.6) are left out.
import { readFile, writeFile } from "node:fs/promises";

const REPO = "https://github.com/accl-kaust/PhiTeX";

export function news(text) {
  const entries = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const para = [];
    for (const l of cur.lines) {
      if (!l.trim()) {
        if (para.length) break;
        continue;
      }
      if (l.startsWith(">")) continue;
      para.push(l.trim());
    }
    entries.push({ version: cur.version, date: cur.date, kind: "release", summary: para.join(" "), url: `${REPO}/releases/tag/v${cur.version}` });
    for (const l of cur.lines) {
      const a = /^>\s*advisory\s+(\S+):\s*(.+)$/.exec(l.trim());
      if (a) entries.push({ kind: "advisory", affects: a[1], summary: a[2].trim(), url: `${REPO}/releases/tag/v${cur.version}` });
    }
  };
  for (const l of text.split("\n")) {
    if (l.startsWith("## ")) {
      flush();
      const m = /^## (\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)/.exec(l);
      cur = m ? { version: m[1], date: m[2], lines: [] } : null;
    } else if (cur) cur.lines.push(l);
  }
  flush();
  const latest = entries.find((e) => e.kind === "release")?.version ?? null;
  return { schema: 1, latest, entries };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error("usage: node scripts/news.mjs <CHANGELOG.md path or URL> <out.json>");
    process.exit(2);
  }
  let text;
  if (/^https:/.test(src)) {
    const r = await fetch(src);
    // Before PhiTeX's first release its main has no CHANGELOG.md: the news then is none. Only then: once a release
    // exists, a missing CHANGELOG.md is an error.
    if (r.status === 404) {
      const rel = await fetch("https://api.github.com/repos/accl-kaust/PhiTeX/releases?per_page=1", { headers: { accept: "application/vnd.github+json" } });
      if (!rel.ok) throw new Error(`${src}: 404, and the releases list: ${rel.status}`);
      if ((await rel.json()).length) throw new Error(`${src}: 404, but PhiTeX has a release`);
      text = "";
    } else if (!r.ok) throw new Error(`${src}: ${r.status}`);
    else text = await r.text();
  } else text = await readFile(src, "utf8");
  const n = news(text);
  await writeFile(out, JSON.stringify(n, null, 1) + "\n");
  console.log(`${out}: latest ${n.latest ?? "none"}, ${n.entries.length} entries`);
}
