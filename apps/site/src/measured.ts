// The correctness and speed page. Every number comes from bench.json, which
// PhiTeX's CI writes from a sweep (one per pinned commit); the page only
// renders it. On the dev server `?bench=PATH` reads another file
// (test/bench-full.json fills every chart, for checking the layout).
import "./style.css";
import "./measured.css";
import { REPO } from "./links";
import { ENGINES, curves, esc, ms, n, secs, type Bench, type Cls, type Cold, type Diff, type Edit, type Engine, type Links, type Machine } from "./bench";

const $ = (s: string) => document.querySelector(s) as HTMLElement;

$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
});

const eng = (e: string) => ENGINES[e] ?? esc(e);
const CLASSES: { key: "identical" | Cls; label: string; short?: string; text: string }[] = [
  { key: "identical", label: "Identical", short: "identical", text: "" },
  { key: "pdftex-bug", label: "pdfTeX's bug", text: "pdfTeX writes something it did not mean to, where its code has a bug. PhiTeX writes what pdfTeX means. Each case is explained in the engine's list of differences, and CI checks that nothing else in the file differs." },
  { key: "slow", label: "Identical, but slow", short: "identical, but slow", text: "The PDF is identical, but PhiTeX takes longer than CI's time limit. A speed problem, which we are working on." },
  { key: "phitex-bug", label: "PhiTeX bug", text: "PhiTeX gets something wrong. Each one has an issue in the engine's repository." },
  { key: "not-examined", label: "Not examined yet", short: "not examined yet", text: "The PDFs differ and we have not found why yet." },
];
const label = (k: string) => CLASSES.find((c) => c.key === k)?.label ?? k;
const href = (b: Bench, l: string) => (/^https?:/.test(l) ? l : `${REPO}/blob/${b.commit}/${l}`);
// A manual's page on texdoc.org (its package: the directory under the doc tree's first), unless the run gave a link.
const docUrl = (d: { doc: string; url?: string }) => d.url ?? (/^(generic|latex|plain|xetex|xelatex)\/([^/]+)\//.test(d.doc) ? `https://texdoc.org/pkg/${d.doc.split("/")[1]}` : null);
const docLinks = (d: Links & { doc: string }) => {
  const u = docUrl(d);
  return [u ? `<a href="${esc(u)}" target="_blank" rel="noopener">manual</a>` : "", d.pdfs ? `<a href="${esc(d.pdfs.phitex)}">PhiTeX's PDF</a> <a href="${esc(d.pdfs.oracle)}">TeX Live's PDF</a>` : ""].filter(Boolean).join(" ");
};

function render(b: Bench) {
  // (a sample: the lists' counts; a partial run: what it covers so far)
  if (b.sample || b.covers) {
    const s = $("#sample");
    s.hidden = false;
    s.innerHTML = b.sample ? `<b>Preliminary:</b> ${esc(b.note ?? "")}` : `<b>Partial:</b> ${esc(b.covers!)}`;
  }
  const engines = b.corpora.flatMap((c) => Object.values(c.engines));
  const sum = (f: (e: Engine) => number) => engines.reduce((a, e) => a + f(e), 0);
  const total = sum((e) => e.total), identical = sum((e) => e.identical);
  const of = (k: Cls) => sum((e) => (k === "slow" ? e.slow ?? 0 : e.by_class[k] ?? 0));
  const differ = of("pdftex-bug") + of("phitex-bug") + of("not-examined");
  const edit = b.timing.edit;
  // (every difference pdfTeX's own bug: said so, with the bug in plain words when there is one)
  const onlyPdftex = differ > 0 && differ === of("pdftex-bug");
  if (onlyPdftex) {
    const bugs = b.differences.filter((d) => d.cls === "pdftex-bug");
    const links = [...new Set(bugs.map((d) => d.link))];
    const one = links.length === 1 && bugs[0].note ? ` ${esc(bugs[0].note)}` : "";
    $("#why-lede").innerHTML = `All ${n(differ)} come from ${links.length === 1 ? "one bug" : "bugs"} in pdfTeX itself, which PhiTeX does not copy.${one}${links.length === 1 && links[0] ? ` <a href="${href(b, links[0])}">Read more…</a>` : ""}`;
  }
  $("#stats").innerHTML = [
    `<div class="hs"><span class="big">${n(identical)} <small>of ${n(total)}</small></span><span>documents give the same PDF as pdfLaTeX or XeLaTeX, byte for byte${of("slow") ? ` (${of("slow")} of them past CI's time limit)` : ""}</span></div>`,
    `<div class="hs"><span class="big">${n(differ)}</span><span>${onlyPdftex ? "differ, all because of a bug in pdfTeX itself, which PhiTeX does not copy." : "differ, each listed below with its reason."} <a href="#why">Read more…</a></span></div>`,
    edit ? `<div class="hs"><span class="big">${n(edit.under_100ms)} <small>of ${n(edit.cases)}</small></span><span>measured edits show their new page within 100 ms</span></div>` : "",
  ].join("");
  const m = b.machine;
  $("#runline").innerHTML = [
    // (the release measured, when the sweep was a release's: PhiTeX's bench.yml names it)
    `PhiTeX ${b.release ? `<a href="${REPO}/releases/tag/${esc(b.release)}">${esc(b.release)}</a> ` : ""}<a href="${REPO}/commit/${esc(b.commit)}"><code>${esc(b.commit.slice(0, 9))}</code></a>`,
    esc(b.date), esc(b.texlive.replace(/,.*/, "")),
    m ? esc(`${m.cpu}, ${m.cores} cores, ${m.mem_gb} GB`) : "",
  ].filter(Boolean).join(" · ");

  // the corpora: one bar per engine, split by reason; a reason's segment shows its documents in the table
  $("#corpora").innerHTML = b.corpora.map((c) => {
    const rows = Object.entries(c.engines).map(([e, s]) => {
      const parts = CLASSES.filter((k) => k.key !== "slow").map((k) => ({ k: k.key, v: k.key === "identical" ? s.identical : s.by_class[k.key as Exclude<Cls, "slow">] ?? 0 })).filter((p) => p.v > 0);
      const bar = parts.map((p) => p.k === "identical"
        ? `<span class="seg c-${p.k}" style="flex-grow:${p.v}" title="${esc(`${label(p.k)}: ${n(p.v)}`)}"></span>`
        : `<button type="button" class="seg c-${p.k}" style="flex-grow:${p.v}" data-cls="${p.k}" data-engine="${e}" title="${esc(`${label(p.k)}: ${n(p.v)}. Show them`)}" aria-label="${esc(`Show the ${n(p.v)} ${label(p.k)} documents for ${ENGINES[e] ?? e}`)}"></button>`).join("");
      const words = parts.map((p) => p.k === "identical"
        ? `<span><i class="c-${p.k}"></i>${n(p.v)} ${CLASSES[0].short}${s.slow ? `, <button type="button" class="word" data-cls="slow" data-engine="${e}">${n(s.slow)} of them slow</button>` : ""}</span>`
        : `<button type="button" class="word" data-cls="${p.k}" data-engine="${e}"><i class="c-${p.k}"></i>${n(p.v)} ${esc(CLASSES.find((k) => k.key === p.k)!.short ?? label(p.k))}</button>`).join("");
      return `<div class="erow"><b>${eng(e)}</b><span class="tot">${n(s.total)} documents</span><div class="bar">${bar}</div><div class="words">${words}</div></div>`;
    }).join("");
    const x = c.excluded;
    const left = x ? `<p class="excl">Left out: ${n(x.total)} manuals that TeX Live's own engines cannot build, or that need LuaLaTeX (${n(x.by_engine.lualatex ?? 0)}). <a href="${href(b, x.link)}">The list, with each one's reason</a>.</p>` : "";
    const lists = c.from_lists ? `<p class="lists">From PhiTeX's test lists, which its CI keeps true; this corpus is not yet in a measured run.</p>` : "";
    return `<div class="corpus card"><h3>${esc(c.title)}</h3><p>${esc(c.about)}</p>${lists}${rows}${left}</div>`;
  }).join("");
  $("#legend").innerHTML = CLASSES.filter((k) => k.key !== "slow").map((k) => `<span><i class="c-${k.key}"></i>${k.label}</span>`).join("");

  // the reasons (each a filter of the table), and every document that differs
  $("#classes").innerHTML = CLASSES.slice(1).map((k) => {
    const v = of(k.key as Cls);
    return `<button type="button" class="card why-c${v ? "" : " zero"}" data-cls="${k.key}"${v ? "" : " disabled"}><span class="big"><i class="c-${k.key}"></i>${n(v)}</span><b>${k.label}</b><p>${k.text}</p></button>`;
  }).join("");
  diffTable(b);

  curves(b.timing.cold, edit, { pdflatex: $("#k-pdflatex"), xelatex: $("#k-xelatex"), edit: $("#k-edit") });
  // (how the times were taken: once, under the curves)
  $("#timed").hidden = !b.method;
  if (b.method) $("#timed").innerHTML = `<summary>How these were timed</summary><p>${esc(b.method).replace(/`([^`]+)`/g, "<code>$1</code>")}</p>`;
  coldChart($("#c-cold"), b.timing.cold, b.machine);
  editChart($("#c-edit"), edit, b.machine);
  methods(b);
}

function diffTable(b: Bench) {
  const order = (d: Diff) => CLASSES.findIndex((k) => k.key === d.cls);
  const slow: Diff[] = (b.slow ?? []).map((x) => ({ ...x, cls: "slow", link: null, note: x.note ?? null }));
  const all = [...b.differences, ...slow].sort((p, q) => order(p) - order(q) || p.doc.localeCompare(q.doc));
  const f = { cls: "", engine: "", q: "" };
  const present = CLASSES.slice(1).filter((k) => all.some((d) => d.cls === k.key));
  $("#dfilter").innerHTML = `<div class="chips" role="group" aria-label="Reason"><button type="button" class="chip-b" data-cls="" aria-pressed="true">All <span>${all.length}</span></button>${present.map((k) => `<button type="button" class="chip-b" data-cls="${k.key}" aria-pressed="false"><i class="c-${k.key}"></i>${k.label} <span>${all.filter((d) => d.cls === k.key).length}</span></button>`).join("")}</div><input type="search" id="dq" placeholder="Find a document" aria-label="Find a document">`;
  const draw = () => {
    const q = f.q.toLowerCase();
    const rows = all.filter((d) => (!f.cls || d.cls === f.cls) && (!f.engine || d.engine === f.engine) && (!q || d.doc.toLowerCase().includes(q)));
    $("#diffs").innerHTML = rows.map((d) => {
      const more = [d.note ? esc(d.note) : "", d.link ? `<a href="${href(b, d.link)}">${/issues\//.test(d.link) ? "issue" : "explained"}</a>` : ""].filter(Boolean).join(" ");
      return `<tr><td><code>${esc(d.doc)}</code><div class="dl">${docLinks(d)}</div></td><td>${eng(d.engine)}</td><td><span class="chip"><i class="c-${d.cls}"></i>${label(d.cls)}</span></td><td>${more}</td></tr>`;
    }).join("") || `<tr><td colspan="4">None.</td></tr>`;
    $("#dfilter").querySelectorAll<HTMLElement>(".chip-b").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.cls === f.cls)));
    $("#dnote").innerHTML = f.engine ? `${eng(f.engine)} only. <button type="button" class="linkish" id="dall">Show both engines</button>` : "";
    $("#dall")?.addEventListener("click", () => { f.engine = ""; draw(); });
  };
  const pick = (cls: string, engine = "") => { f.cls = cls; f.engine = engine; draw(); };
  $("#dfilter").addEventListener("click", (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>(".chip-b"); if (c) pick(c.dataset.cls!, f.engine); });
  ($("#dq") as HTMLInputElement).addEventListener("input", (e) => { f.q = (e.target as HTMLInputElement).value; draw(); });
  // a bar's segment or a reason's card: that reason's documents
  document.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("#corpora [data-cls], #classes [data-cls]");
    if (!t) return;
    pick(t.dataset.cls!, t.dataset.engine ?? "");
    $("#dtable").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  });
  draw();
}

const tipOn = (el: HTMLElement) => {
  const tip = el.querySelector(".tip") as HTMLElement;
  el.querySelectorAll<SVGElement>("[data-tip]").forEach((g) => {
    g.addEventListener("pointerenter", () => { tip.hidden = false; tip.innerHTML = g.dataset.tip!; tip.style.left = g.dataset.x!; tip.style.top = g.dataset.y!; });
    g.addEventListener("pointerleave", () => (tip.hidden = true));
  });
};

/**
 * Every document, one dot: across, the TeX Live engine's cold build; up,
 * PhiTeX's, both log scales, so the diagonal is "as fast" and a dot under
 * it is a document PhiTeX builds faster. Engines are toggled, a document
 * found by name, and a dot hovered or clicked shows its times and links.
 */
// A dot per case: TeX Live's time across, PhiTeX's up (both log scale), its
// diagonals the ratios; hover reads a dot, a click pins it with its links.
interface Dot extends Links { doc: string; engine: string; oracle_s: number; phitex_s: number; edit?: string; }
interface ScatterOpts { key: string; title: string; sub: string; pending: string; what: string; across: string; up: string; diags: [number, string, string, number][]; sum: (e: string, pts: Dot[]) => string; foot: string; }
function scatter(el: HTMLElement, pts: Dot[], o: ScatterOpts) {
  const head = `<figcaption><b>${o.title}</b><span class="sub">${o.sub}</span></figcaption>`;
  if (!pts.length) return void (el.classList.add("waiting"), el.innerHTML = `${head}<p class="pending">${o.pending}</p>`);
  const engs = [...new Set(pts.map((p) => p.engine))];
  const on = new Set(engs);
  let pinned: Dot | null = null;
  const name = (p: Dot) => (p.edit ? `${p.edit} in ${p.doc}` : p.doc);
  const summary = engs.map((e) => `<button type="button" class="chip-b ser" data-e="${e}" aria-pressed="true"><i class="s-texlive${e === "xelatex" ? "" : " round"}"></i>${eng(e)} <span>${n(pts.filter((p) => p.engine === e).length)}</span></button><span class="sum">${o.sum(e, pts.filter((p) => p.engine === e))}</span>`).join("");
  el.innerHTML = `${head}<div class="ctrl"><div class="chips" role="group" aria-label="Engines">${summary}</div><input type="search" list="${o.key}-docs" placeholder="Find a document" aria-label="Find a document"><datalist id="${o.key}-docs">${[...new Set(pts.map((p) => p.doc))].map((d) => `<option value="${esc(d)}">`).join("")}</datalist></div>
    <div class="plot"><svg viewBox="0 0 880 560" role="img" aria-label="${esc(o.what)}"></svg><div class="tip" hidden></div></div>
    <div class="pin" hidden></div>${o.foot}
    <details><summary>Table view</summary><table><thead><tr><th>document</th>${pts.some((p) => p.edit) ? "<th>edit</th>" : ""}<th>engine</th><th>TeX Live</th><th>PhiTeX</th><th>ratio</th></tr></thead><tbody>${[...pts].sort((p, q) => q.phitex_s / q.oracle_s - p.phitex_s / p.oracle_s).map((p) => `<tr><td>${esc(p.doc)}</td>${p.edit ? `<td>${esc(p.edit)}</td>` : ""}<td>${eng(p.engine)}</td><td>${secs(p.oracle_s)}</td><td>${secs(p.phitex_s)}</td><td>${(p.phitex_s / p.oracle_s).toPrecision(2)}×</td></tr>`).join("")}</tbody></table></details>`;
  const svg = el.querySelector("svg")!, tip = el.querySelector(".tip") as HTMLElement, pin = el.querySelector(".pin") as HTMLElement;
  const W = 880, H = 560, m = { l: 64, r: 24, t: 20, b: 52 };
  // (each axis its own decades: an edit's times are far under a rebuild's)
  const span = (v: number[]) => [Math.floor(Math.log10(Math.min(...v))), Math.ceil(Math.log10(Math.max(...v)))];
  const [xlo, xhi] = span(pts.map((p) => p.oracle_s)), [ylo, yhi] = span(pts.map((p) => p.phitex_s));
  const X = (v: number) => m.l + ((Math.log10(v) - xlo) / (xhi - xlo)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((Math.log10(v) - ylo) / (yhi - ylo)) * (H - m.t - m.b);
  const tick = (e: number) => secs(10 ** e).replace(/\.0 s$/, " s");
  let axes = "";
  for (let e = xlo; e <= xhi; e++) axes += `<line class="grid" x1="${X(10 ** e)}" x2="${X(10 ** e)}" y1="${m.t}" y2="${H - m.b}"/><text class="tick" x="${X(10 ** e)}" y="${H - m.b + 20}" text-anchor="middle">${tick(e)}</text>`;
  for (let e = ylo; e <= yhi; e++) axes += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}"/><text class="tick" x="${m.l - 8}" y="${Y(10 ** e) + 4}" text-anchor="end">${tick(e)}</text>`;
  // the diagonals: PhiTeX's time k times TeX Live's
  for (const [k, cls, txt, t] of o.diags) {
    // (the line y = kx inside the plot)
    const x0 = Math.max(10 ** xlo, 10 ** ylo / k), x1 = Math.min(10 ** xhi, 10 ** yhi / k);
    if (x0 >= x1) continue;
    const ax = X(x0), ay = Y(x0 * k), bx = X(x1), by = Y(x1 * k);
    const lx = ax + (bx - ax) * t, ly = ay + (by - ay) * t, deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    axes += `<line class="${cls}" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/><text class="tick diag" transform="translate(${lx} ${ly}) rotate(${deg})" y="-6" text-anchor="middle">${txt}</text>`;
  }
  axes += `<text class="tick strong" x="${(m.l + W - m.r) / 2}" y="${H - 8}" text-anchor="middle">${o.across}</text><text class="tick strong" transform="translate(16 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">${o.up}</text>`;
  const draw = () => {
    // (XeLaTeX's squares, the others circles)
    const dot = (p: Dot, on = false) => {
      const x = X(p.oracle_s).toFixed(1), y = Y(p.phitex_s).toFixed(1), r = on ? 7 : 3.5, cls = `dot s-texlive${on ? " on" : ""}`;
      return p.engine === "xelatex" ? `<rect class="${cls}" x="${+x - r}" y="${+y - r}" width="${2 * r}" height="${2 * r}"/>` : `<circle class="${cls}" cx="${x}" cy="${y}" r="${r}"/>`;
    };
    // (the pinned one last, over the rest)
    const dots = pts.filter((p) => on.has(p.engine) && p !== pinned).map((p) => dot(p)).join("") + (pinned && on.has(pinned.engine) ? dot(pinned, true) : "");
    svg.innerHTML = axes + dots + `<rect class="hitbar" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>`;
    el.querySelectorAll<HTMLElement>(".ser").forEach((b) => b.setAttribute("aria-pressed", String(on.has(b.dataset.e!))));
  };
  const at = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
    let best: Dot | null = null, bd = 14 * 14;
    for (const p of pts) {
      if (!on.has(p.engine)) continue;
      const d = (X(p.oracle_s) - px) ** 2 + (Y(p.phitex_s) - py) ** 2;
      if (d < bd) (bd = d), (best = p);
    }
    return best;
  };
  const about = (p: Dot) => {
    const r = p.phitex_s / p.oracle_s;
    return `<b>${esc(p.doc)}</b>${p.edit ? `<div>${esc(p.edit)}</div>` : ""}<div>${eng(p.engine)}${p.edit ? ", a rebuild" : ""} <span>${secs(p.oracle_s)}</span></div><div>PhiTeX${p.edit ? ", the edit" : ""} <span>${secs(p.phitex_s)}</span></div><div>${r < 1 ? `${(1 / r).toFixed(r < 0.1 ? 0 : 1)}× faster` : `${r.toFixed(1)}× slower`}</div>`;
  };
  const show = (p: Dot | null) => {
    pinned = p;
    pin.hidden = !p;
    if (p) pin.innerHTML = `${about(p)}<div class="dl">${docLinks(p)}</div><button type="button" class="linkish">Close</button>`;
    pin.querySelector("button")?.addEventListener("click", () => show(null));
    draw();
  };
  svg.addEventListener("pointermove", (e) => {
    const p = at(e);
    svg.style.cursor = p ? "pointer" : "";
    tip.hidden = !p;
    if (!p) return;
    tip.innerHTML = about(p);
    tip.style.left = `${(X(p.oracle_s) / W) * 100}%`;
    tip.style.top = `${((Y(p.phitex_s) - 10) / H) * 100}%`;
  });
  svg.addEventListener("pointerleave", () => (tip.hidden = true));
  svg.addEventListener("click", (e) => show(at(e)));
  el.querySelectorAll<HTMLElement>(".ser").forEach((b) => b.addEventListener("click", () => {
    const e = b.dataset.e!;
    if (on.has(e) && on.size > 1) on.delete(e); else on.add(e);
    draw();
  }));
  // (a document's slowest case, where it has several)
  (el.querySelector("input") as HTMLInputElement).addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    const hits = q ? pts.filter((p) => p.doc.toLowerCase().includes(q)) : [];
    const docs = new Set(hits.map((p) => p.doc.toLowerCase()));
    if (docs.size === 1 || docs.has(q)) {
      const p = hits.filter((h) => docs.size === 1 || h.doc.toLowerCase() === q).sort((x, y) => y.phitex_s - x.phitex_s)[0];
      on.add(p.engine);
      show(p);
    }
  });
  draw();
}

function coldChart(el: HTMLElement, c: Cold | null, mach: Machine | null) {
  scatter(el, c?.points ?? [], {
    key: "cold",
    title: "A clean build, document by document",
    sub: "Each dot is one document. Under the diagonal, PhiTeX is faster.",
    pending: "Being measured: each document built by both engines back to back on one machine.",
    what: "PhiTeX's clean build time against TeX Live's, per document",
    across: "TeX Live, every run the document needs",
    up: "PhiTeX, one build",
    diags: [[1, "one", "as fast", 0.9], [2, "half", "2× slower", 0.72], [0.5, "half", "2× faster", 0.9]],
    sum: (e, pts) => { const s = c!.summary[e]; return `${s ? `median ${s.p50_ratio}× its time, 9 in 10 under ${s.p90_ratio}×; ` : ""}faster on ${n(pts.filter((p) => p.phitex_s < p.oracle_s).length)}`; },
    foot: mach ? `<p class="worst">${esc(mach.cpu)}, one thread, one document at a time.</p>` : "",
  });
}

function editChart(el: HTMLElement, e: Edit | null, mach: Machine | null) {
  const pts: Dot[] = (e?.points ?? []).map((p) => ({ ...p, phitex_s: p.ms / 1000 }));
  const med = (v: number[]) => v.sort((p, q) => p - q)[Math.floor((v.length - 1) / 2)];
  scatter(el, pts, {
    key: "edit",
    title: "An edit, edit by edit",
    sub: "Each dot is one edit: PhiTeX's time from the save to its new page, against TeX Live rebuilding the edited document.",
    pending: "Being measured: edits in real documents, each beside a full rebuild by TeX Live.",
    what: "PhiTeX's time for an edit against TeX Live's rebuild of the edited document, per edit",
    across: "TeX Live, a full rebuild of the edited document",
    up: "PhiTeX, the edit",
    diags: [[1, "one", "as fast", 0.9], [0.1, "half", "10× faster", 0.9], [0.01, "half", "100× faster", 0.9], [0.001, "half", "1000× faster", 0.9]],
    sum: (_, pts) => { const r = med(pts.map((p) => p.oracle_s / p.phitex_s)); const d = new Set(pts.map((p) => p.doc)).size; return `${n(d)} document${d === 1 ? "" : "s"}, median ${r.toFixed(r < 10 ? 1 : 0)}× faster than its rebuild`; },
    foot: [e?.note ? `<p class="worst">${esc(e.note)}</p>` : "", mach ? `<p class="worst">${esc(mach.cpu)}, one thread.</p>` : ""].join(""),
  });
}

function methods(b: Bench) {
  const corpora = b.corpora.map((c) => c.title).join(" and ");
  $("#methods").innerHTML = [
    ["Documents", `${esc(corpora)}, each with its sources fixed by hash. The lists are in the engine's repository, with every document left out and why.`],
    ["Reference", `${esc(b.texlive)}. Its pdfLaTeX and XeLaTeX run each document as many times as it needs, with BibTeX, biber and makeindex, as latexmk does. PhiTeX reaches the same PDF in one build.`],
    ["Machine", b.machine ? esc(`${b.machine.cpu}, ${b.machine.cores} cores, ${b.machine.mem_gb} GB, Linux. ${b.machine.note ? `${b.machine.note[0].toUpperCase()}${b.machine.note.slice(1)}.` : "One document at a time."}`) : "Named here with the measurement run. One document at a time, on Linux."],
    ["Reproducible", `Every number is from one run of PhiTeX's CI on <a href="${REPO}/commit/${esc(b.commit)}">commit ${esc(b.commit.slice(0, 9))}</a>, and the scripts are in its repository. <a href="${esc(src)}">The raw results</a>.`],
  ].map(([t, p]) => `<div class="card m"><b>${t}</b><p>${p}</p></div>`).join("");
}

// (`?bench=` only on the dev server: on the site a link must not make the page show numbers of its choosing)
const src = (import.meta.env.DEV && new URLSearchParams(location.search).get("bench")) || "bench.json";
fetch(src).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(render, (e) => {
  $("#stats").innerHTML = `<p class="pending">The results could not be loaded (${esc(String(e))}).</p>`;
});
