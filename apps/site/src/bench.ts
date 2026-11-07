// bench.json, PhiTeX CI's results (measured.html renders them; the home page
// draws its three speed curves small): the types, and the curves.
import "./charts.css";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const n = (v: number) => v.toLocaleString("en-US");
export const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
export const secs = (v: number) => (v >= 600 ? `${Math.round(v / 60)} min` : v >= 100 ? `${Math.round(v)} s` : v >= 1 ? `${v.toFixed(1)} s` : `${Math.round(v * 1000)} ms`);
export const ENGINES: Record<string, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX", pdftex: "pdfTeX" };

export type Cls = "pdftex-bug" | "slow" | "phitex-bug" | "not-examined";
/** `identical` counts the slow ones too (their PDFs match; `slow` of them run past CI's time limit); `by_class` only the ways a PDF differs. */
export interface Engine { total: number; identical: number; slow?: number; by_class: Partial<Record<Exclude<Cls, "slow">, number>>; }
/** `from_lists`: its counts from PhiTeX's test lists, not yet from a measured run. */
export interface Corpus { from_lists?: boolean; name: string; title: string; about: string; excluded: { total: number; by_engine: Record<string, number>; link: string } | null; engines: Record<string, Engine>; }
export interface Machine { cpu: string; cores: number; mem_gb: number; nodes?: string[]; note?: string; }
/** A document's links: its source or manual (`url`), and the two PDFs as built (`pdfs`). */
export interface Links { url?: string; pdfs?: { phitex: string; oracle: string }; }
export interface Point extends Links { doc: string; engine: string; oracle_s: number; phitex_s: number; }
export interface Cold { runs: number; summary: Record<string, { docs: number; p50_ratio: number; p90_ratio: number }>; points: Point[]; }
/** `points`: each edit, PhiTeX's time to its page and a rebuild of its document by the document's own engine (`oracle_s`). */
export interface EditPoint extends Links { doc: string; engine: string; edit: string; ms: number; oracle_s: number; same_pdf_as_oracle?: boolean; }
export interface Edit { note?: string; points?: EditPoint[]; cases: number; under_100ms: number; p50_ms: number | null; buckets: { le_ms: number | null; n: number }[] | null; worst: { doc: string; edit: string; ms: number }[] | null; }
export interface Diff extends Links { corpus: string; doc: string; engine: string; cls: Cls; link: string | null; note: string | null; }
/** A document identical but past CI's time limit. */
export interface Slow extends Links { corpus: string; doc: string; engine: string; note?: string | null; }
/** `covers`: a run not yet over every corpus says what it measured. */
/** `method`: how the times were taken, in words (shown beside the speed charts). */
export interface Bench { method?: string; covers?: string; slow?: Slow[]; schema: number; sample?: boolean; note?: string; commit: string; date: string; texlive: string; machine: Machine | null; corpora: Corpus[]; timing: { cold: Cold | null; edit: Edit | null }; differences: Diff[]; }

/**
 * Speed curves: for each time across (log scale), the share of documents
 * done within it; the curve further left is faster. The first series is
 * PhiTeX's (solid), the others TeX Live's engines (dashed, dotted). Hovering
 * reads every curve at that time; a dot marks each median.
 */
export interface Series { name: string; vals: number[]; }
/** `verdict`: the sentence said instead of the medians' ratio (where the series are not the same documents). */
export function curveChart(el: HTMLElement, o: { title: string; sub: string; series: Series[]; note?: string; mini?: boolean; verdict?: string }) {
  const W = 420, H = 300, m = { l: 44, r: 22, t: 16, b: 46 };
  const S = o.series.map((x, i) => ({ ...x, vals: [...x.vals].sort((p, q) => p - q), cls: i ? `s-texlive ${["", "dash", "dot", "dashdot"][i] ?? "dot"}` : "s-phitex" }));
  const all = S.flatMap((x) => x.vals);
  const lo = Math.floor(Math.log10(Math.min(...all))), hi = Math.ceil(Math.log10(Math.max(...all)));
  const X = (v: number) => m.l + ((Math.log10(v) - lo) / (hi - lo)) * (W - m.l - m.r);
  const Y = (f: number) => H - m.b - f * (H - m.t - m.b);
  const share = (s: number[], t: number) => { let i = 0, j = s.length; while (i < j) { const k = (i + j) >> 1; if (s[k] <= t) i = k + 1; else j = k; } return i / s.length; };
  const path = (s: number[]) => `M${X(10 ** lo)},${Y(0)}` + s.map((v, i) => `H${X(v).toFixed(1)}V${Y((i + 1) / s.length).toFixed(1)}`).join("") + `H${X(10 ** hi)}`;
  const med = (s: number[]) => s[Math.floor((s.length - 1) / 2)];
  let g = "";
  for (const f of [0, 0.25, 0.5, 0.75, 1]) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(f)}" y2="${Y(f)}"/><text class="tick" x="${m.l - 6}" y="${Y(f) + 4}" text-anchor="end">${f * 100}%</text>`;
  for (let e = lo; e <= hi; e++) g += `<text class="tick" x="${X(10 ** e)}" y="${H - m.b + 18}" text-anchor="middle">${secs(10 ** e).replace(/\.0 s$/, " s")}</text>`;
  g += `<text class="tick strong" x="${(m.l + W - m.r) / 2}" y="${H - 8}" text-anchor="middle">time (log scale)</text>`;
  // (PhiTeX's last, over the rest)
  for (const x of [...S].reverse()) g += `<path class="curve ${x.cls}" d="${path(x.vals)}"/><circle class="mdot ${x.cls}" cx="${X(med(x.vals))}" cy="${Y(0.5)}" r="5"/>`;
  g += `<line class="cross" x1="-10" x2="-10" y1="${m.t}" y2="${H - m.b}"/><rect class="hitbar" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>`;
  const ours = med(S[0].vals);
  const verdict = S.slice(1).map((x) => { const r = ours / med(x.vals); return r < 1 ? `<b>${(1 / r).toFixed(r < 0.1 ? 0 : 1)}× faster</b> than ${esc(x.name.replace(/,.*/, ""))}` : `<b>${r.toFixed(1)}× slower</b> than ${esc(x.name.replace(/,.*/, ""))}`; }).join(", ");
  const key = (x: (typeof S)[number]) => `<i class="${x.cls}"></i>`;
  const ticks = Array.from({ length: (hi - lo) * 2 + 1 }, (_, i) => 10 ** (lo + i / 2));
  el.innerHTML = `<div class="head"><figcaption><b>${o.title}</b><div class="sub">${o.sub}</div></figcaption>
    <div class="legend">${S.map((x) => `<span>${key(x)}${esc(x.name)}, median ${secs(med(x.vals))}</span>`).join("")}</div>
    <p class="verdict">${o.verdict ?? `PhiTeX's median is ${verdict}`}.</p></div>
    <div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}">${g}</svg><div class="tip" hidden></div></div>${o.mini ? "" : `${o.note ?? ""}
    <details><summary>Table view</summary><table><thead><tr><th>within</th>${S.map((x) => `<th>${esc(x.name)}</th>`).join("")}</tr></thead><tbody>${ticks.map((t) => `<tr><td>${secs(t)}</td>${S.map((x) => `<td>${(share(x.vals, t) * 100).toFixed(0)}%</td>`).join("")}</tr>`).join("")}</tbody></table></details>`}`;
  const svg = el.querySelector("svg")!, tip = el.querySelector(".tip") as HTMLElement, cross = el.querySelector(".cross")!;
  svg.addEventListener("pointermove", (e) => {
    const b = svg.getBoundingClientRect(), px = Math.min(W - m.r, Math.max(m.l, ((e.clientX - b.left) / b.width) * W));
    const t = 10 ** (lo + ((px - m.l) / (W - m.l - m.r)) * (hi - lo));
    cross.setAttribute("x1", String(px)); cross.setAttribute("x2", String(px));
    tip.hidden = false;
    tip.innerHTML = `<b>within ${secs(t)}</b>` + S.map((x) => `<div>${key(x)}${esc(x.name)} <span>${(share(x.vals, t) * 100).toFixed(0)}%</span></div>`).join("");
    tip.style.left = `${(px / W) * 100}%`; tip.style.top = "20%";
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("x1", "-10"); cross.setAttribute("x2", "-10"); });
}

/** The three curves into their figures: cold against pdfLaTeX, cold against XeLaTeX, an edit against a rebuild by each. `mini`: small, on the home page (no table view, no notes). */
export function curves(c: Cold | null, e: Edit | null, into: { pdflatex: HTMLElement; xelatex: HTMLElement; edit: HTMLElement }, mini = false) {
  const pending = (el: HTMLElement, title: string, text: string) => { el.classList.add("waiting"); el.innerHTML = `<figcaption><b>${title}</b></figcaption><p class="pending">${text}</p>`; };
  for (const en of ["pdflatex", "xelatex"] as const) {
    const pts = c?.points.filter((p) => p.engine === en) ?? [];
    const title = `A clean build, against ${ENGINES[en]}`;
    if (!pts.length) pending(into[en], title, `Being measured: each document built by PhiTeX and by ${ENGINES[en]} back to back on one machine.`);
    else curveChart(into[en], { mini, title, sub: `${n(pts.length)} documents.`, series: [{ name: "PhiTeX, one build", vals: pts.map((p) => p.phitex_s) }, { name: `${ENGINES[en]}, every run`, vals: pts.map((p) => p.oracle_s) }] });
  }
  const title = "After an edit";
  if (!e) return pending(into.edit, title, "Being measured.");
  if (!e.points?.length) return pending(into.edit, title, `<b>${n(e.under_100ms)} of ${n(e.cases)}</b> measured edits show their new page within 100 ms${e.p50_ms != null ? `, a median of ${ms(e.p50_ms)}` : ""}. The curve against a full rebuild comes with the next measurement run.`);
  const worst = e.worst?.length ? `<p class="worst"><b>Slowest:</b> ${e.worst.slice(0, 3).map((w) => `${ms(w.ms)} for ${esc(w.edit)} in <code>${esc(w.doc)}</code>`).join("; ")}.</p>` : "";
  // (PhiTeX's every edit; against it, each edited document rebuilt by its own engine)
  const engs = Object.keys(ENGINES).filter((x) => e.points!.some((p) => p.engine === x));
  // (each edit against its own document's rebuild: the series' medians are of different documents)
  const ratio = (x: string) => { const r = e.points!.filter((p) => p.engine === x).map((p) => (p.oracle_s * 1000) / p.ms).sort((p, q) => p - q); return r[Math.floor((r.length - 1) / 2)]; };
  const times = (r: number) => `${r.toFixed(r < 10 ? 1 : 0)}×`;
  curveChart(into.edit, {
    mini,
    title,
    sub: `${n(e.points.length)} edits in real documents: PhiTeX's time to the new page, and a full rebuild of the same document by its engine.`,
    series: [{ name: "PhiTeX, the edit", vals: e.points.map((p) => p.ms / 1000) }, ...engs.map((x) => ({ name: `${ENGINES[x]}, a rebuild`, vals: e.points!.filter((p) => p.engine === x).map((p) => p.oracle_s) }))],
    note: worst,
    verdict: `PhiTeX's median edit is ${engs.map((x, i) => `<b>${times(ratio(x))}${i ? "" : " faster"}</b> than ${ENGINES[x]}`).join(", ")} rebuilding the same document`,
  });
}

