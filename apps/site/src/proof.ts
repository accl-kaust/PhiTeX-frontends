// The correctness and speed page. Every number comes from bench.json, which
// PhiTeX's CI writes from a sweep (one per pinned commit); the page only
// renders it. On the dev server `?bench=PATH` reads another file
// (test/bench-full.json fills every chart, for checking the layout).
import "./style.css";
import "./proof.css";
import { REPO } from "./links";
import { ENGINES, curves, esc, ms, n, secs, type Bench, type Cls, type Cold, type Diff, type Engine, type Links, type Machine, type Point } from "./bench";

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
    `PhiTeX <a href="${REPO}/commit/${esc(b.commit)}"><code>${esc(b.commit.slice(0, 9))}</code></a>`,
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
    return `<div class="corpus card"><h3>${esc(c.title)}</h3><p>${esc(c.about)}</p>${rows}${left}</div>`;
  }).join("");
  $("#legend").innerHTML = CLASSES.filter((k) => k.key !== "slow").map((k) => `<span><i class="c-${k.key}"></i>${k.label}</span>`).join("");

  // the reasons (each a filter of the table), and every document that differs
  $("#classes").innerHTML = CLASSES.slice(1).map((k) => {
    const v = of(k.key as Cls);
    return `<button type="button" class="card why-c${v ? "" : " zero"}" data-cls="${k.key}"${v ? "" : " disabled"}><span class="big"><i class="c-${k.key}"></i>${n(v)}</span><b>${k.label}</b><p>${k.text}</p></button>`;
  }).join("");
  diffTable(b);

  curves(b.timing.cold, edit, { pdflatex: $("#k-pdflatex"), xelatex: $("#k-xelatex"), edit: $("#k-edit") });
  coldChart($("#c-cold"), b.timing.cold, b.machine);
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
function coldChart(el: HTMLElement, c: Cold | null, mach: Machine | null) {
  const head = `<figcaption><b>A cold build, document by document</b><span class="sub">Each dot is one document, built from nothing by PhiTeX and by pdfLaTeX or XeLaTeX on the same machine${c ? `, each time the median of ${c.runs} runs` : ""}. Under the diagonal, PhiTeX is faster.</span></figcaption>`;
  if (!c?.points.length) return void (el.classList.add("waiting"), el.innerHTML = `${head}<p class="pending">Being measured: each document built by both engines back to back on one machine. Cold builds are often slower than pdfLaTeX's today. PhiTeX's work went to identical output first and to edits second.</p>`);
  const engs = [...new Set(c.points.map((p) => p.engine))];
  const on = new Set(engs);
  let pinned: Point | null = null;
  const summary = engs.map((e) => {
    const s = c.summary[e];
    const pts = c.points.filter((p) => p.engine === e);
    const faster = pts.filter((p) => p.phitex_s < p.oracle_s).length;
    return `<button type="button" class="chip-b ser" data-e="${e}" aria-pressed="true"><i class="s-texlive${e === "xelatex" ? "" : " round"}"></i>${eng(e)} <span>${n(pts.length)}</span></button><span class="sum">${s ? `median ${s.p50_ratio}× its time, 9 in 10 under ${s.p90_ratio}×; ` : ""}faster on ${n(faster)}</span>`;
  }).join("");
  el.innerHTML = `${head}<div class="ctrl"><div class="chips" role="group" aria-label="Engines">${summary}</div><input type="search" list="cold-docs" id="cq" placeholder="Find a document" aria-label="Find a document"><datalist id="cold-docs">${c.points.map((p) => `<option value="${esc(p.doc)}">`).join("")}</datalist></div>
    <div class="plot"><svg viewBox="0 0 880 560" role="img" aria-label="PhiTeX's cold build time against TeX Live's, per document"></svg><div class="tip" hidden></div></div>
    <div class="pin" id="cpin" hidden></div>${mach ? `<p class="worst">${esc(mach.cpu)}, one thread, one document at a time.</p>` : ""}
    <details><summary>Table view</summary><table><thead><tr><th>document</th><th>engine</th><th>TeX Live</th><th>PhiTeX</th><th>ratio</th></tr></thead><tbody>${[...c.points].sort((p, q) => q.phitex_s / q.oracle_s - p.phitex_s / p.oracle_s).map((p) => `<tr><td>${esc(p.doc)}</td><td>${eng(p.engine)}</td><td>${secs(p.oracle_s)}</td><td>${secs(p.phitex_s)}</td><td>${(p.phitex_s / p.oracle_s).toFixed(2)}×</td></tr>`).join("")}</tbody></table></details>`;
  const svg = el.querySelector("svg")!, tip = el.querySelector(".tip") as HTMLElement, pin = el.querySelector("#cpin") as HTMLElement;
  const W = 880, H = 560, m = { l: 64, r: 24, t: 20, b: 52 };
  const vals = c.points.flatMap((p) => [p.oracle_s, p.phitex_s]);
  const lo = Math.floor(Math.log10(Math.min(...vals))), hi = Math.ceil(Math.log10(Math.max(...vals)));
  const X = (v: number) => m.l + ((Math.log10(v) - lo) / (hi - lo)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((Math.log10(v) - lo) / (hi - lo)) * (H - m.t - m.b);
  const tick = (e: number) => secs(10 ** e).replace(/\.0 s$/, " s");
  let axes = "";
  for (let e = lo; e <= hi; e++) axes += `<line class="grid" x1="${X(10 ** e)}" x2="${X(10 ** e)}" y1="${m.t}" y2="${H - m.b}"/><line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}"/><text class="tick" x="${X(10 ** e)}" y="${H - m.b + 20}" text-anchor="middle">${tick(e)}</text><text class="tick" x="${m.l - 8}" y="${Y(10 ** e) + 4}" text-anchor="end">${tick(e)}</text>`;
  const a = 10 ** lo, z = 10 ** hi;
  // the diagonals: as fast, and twice as slow or fast
  for (const [k, cls, txt, t] of [[1, "one", "as fast", 0.9], [2, "half", "2× slower", 0.72], [0.5, "half", "2× faster", 0.9]] as const) {
    const x0 = Math.max(a, a / k), x1 = Math.min(z, z / k);
    const ax = X(x0), ay = Y(x0 * k), bx = X(x1), by = Y(x1 * k);
    const lx = ax + (bx - ax) * t, ly = ay + (by - ay) * t, deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    axes += `<line class="${cls}" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/><text class="tick diag" transform="translate(${lx} ${ly}) rotate(${deg})" y="-6" text-anchor="middle">${txt}</text>`;
  }
  axes += `<text class="tick strong" x="${(m.l + W - m.r) / 2}" y="${H - 8}" text-anchor="middle">pdfLaTeX or XeLaTeX (TeX Live)</text><text class="tick strong" transform="translate(16 ${(m.t + H - m.b) / 2}) rotate(-90)" text-anchor="middle">PhiTeX</text>`;
  const draw = () => {
    // (pdfLaTeX's documents circles, XeLaTeX's squares)
    const dot = (p: Point, on = false) => {
      const x = X(p.oracle_s).toFixed(1), y = Y(p.phitex_s).toFixed(1), r = on ? 7 : 3.5, cls = `dot s-texlive${on ? " on" : ""}`;
      return p.engine === "xelatex" ? `<rect class="${cls}" x="${+x - r}" y="${+y - r}" width="${2 * r}" height="${2 * r}"/>` : `<circle class="${cls}" cx="${x}" cy="${y}" r="${r}"/>`;
    };
    // (the pinned one last, over the rest)
    const dots = c.points.filter((p) => on.has(p.engine) && p !== pinned).map((p) => dot(p)).join("") + (pinned && on.has(pinned.engine) ? dot(pinned, true) : "");
    svg.innerHTML = axes + dots + `<rect class="hitbar" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>`;
    el.querySelectorAll<HTMLElement>(".ser").forEach((b) => b.setAttribute("aria-pressed", String(on.has(b.dataset.e!))));
  };
  const at = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
    let best: Point | null = null, bd = 14 * 14;
    for (const p of c.points) {
      if (!on.has(p.engine)) continue;
      const d = (X(p.oracle_s) - px) ** 2 + (Y(p.phitex_s) - py) ** 2;
      if (d < bd) (bd = d), (best = p);
    }
    return best;
  };
  const about = (p: Point) => {
    const r = p.phitex_s / p.oracle_s;
    return `<b>${esc(p.doc)}</b><div>${eng(p.engine)} <span>${secs(p.oracle_s)}</span></div><div>PhiTeX <span>${secs(p.phitex_s)}</span></div><div>${r < 1 ? `${(1 / r).toFixed(1)}× faster` : `${r.toFixed(1)}× slower`}</div>`;
  };
  const show = (p: Point | null) => {
    pinned = p;
    pin.hidden = !p;
    if (p) pin.innerHTML = `${about(p)}<div class="dl">${docLinks(p)}</div><button type="button" class="linkish" id="cunpin">Close</button>`;
    pin.querySelector("#cunpin")?.addEventListener("click", () => show(null));
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
  (el.querySelector("#cq") as HTMLInputElement).addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    const hits = q ? c.points.filter((p) => p.doc.toLowerCase().includes(q)) : [];
    if (hits.length === 1 || hits.some((p) => p.doc.toLowerCase() === q)) {
      const p = hits.find((h) => h.doc.toLowerCase() === q) ?? hits[0];
      on.add(p.engine);
      show(p);
    }
  });
  draw();
}

function methods(b: Bench) {
  const corpora = b.corpora.map((c) => c.title).join(" and ");
  $("#methods").innerHTML = [
    ["Documents", `${esc(corpora)}, each with its sources fixed by hash. The lists are in the engine's repository, with every document left out and why.`],
    ["Reference", `${esc(b.texlive)}. Its pdfLaTeX and XeLaTeX build each document as many times as it needs, and so does PhiTeX.`],
    ["Machine", b.machine ? esc(`${b.machine.cpu}, ${b.machine.cores} cores, ${b.machine.mem_gb} GB, Linux. One document at a time.`) : "Named here with the measurement run. One document at a time, on Linux."],
    ["Reproducible", `Every number is from one run of PhiTeX's CI on <a href="${REPO}/commit/${esc(b.commit)}">commit ${esc(b.commit.slice(0, 9))}</a>, and the scripts are in its repository. <a href="${esc(src)}">The raw results</a>.`],
  ].map(([t, p]) => `<div class="card m"><b>${t}</b><p>${p}</p></div>`).join("");
}

// (`?bench=` only on the dev server: on the site a link must not make the page show numbers of its choosing)
const src = (import.meta.env.DEV && new URLSearchParams(location.search).get("bench")) || "bench.json";
fetch(src).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then(render, (e) => {
  $("#stats").innerHTML = `<p class="pending">The results could not be loaded (${esc(String(e))}).</p>`;
});
