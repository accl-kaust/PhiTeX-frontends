// The byte-exactness and performance page. PLACEHOLDER data: every number
// here stands in for a benchmark run; replace DATA with the published results.
import "./style.css";
import "./proof.css";

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
  draw();
});

const DATA = {
  // corpus → [identical, total] per engine (TeX, pdfTeX, XeTeX, LuaTeX)
  matrix: [
    ["TRIP test", [1, 1], [1, 1], [1, 1], [1, 1]],
    ["TeX Live docs (plain)", [2140, 2140], [2140, 2140], [2138, 2140], [2139, 2140]],
    ["TeX Live docs (LaTeX)", [4820, 4820], [4820, 4820], [4817, 4820], [4816, 4820]],
    ["arXiv sample", [5519, 5519], [5519, 5519], [5512, 5519], [5510, 5519]],
  ] as [string, ...[number, number][]][],
  // pages → median ms
  latency: {
    pages: [1, 5, 20, 50, 100, 200, 400],
    phitex: [4.5, 5.1, 5.8, 6.4, 7.0, 7.9, 9.0],
    full: [310, 820, 2400, 5600, 10900, 21500, 43000],
  },
  // cores → full-build speedup
  cores: { n: [1, 2, 4, 8, 16], speedup: [1, 1.9, 3.6, 6.5, 10.8] },
};

// the matrix
{
  const pct = ([a, b]: [number, number]) => (a === b ? `<span class="ok">✓ ${a.toLocaleString()}</span>` : `<span class="near">${((a / b) * 100).toFixed(2)}%</span><small>${a.toLocaleString()} / ${b.toLocaleString()}</small>`);
  $("#matrix").innerHTML = DATA.matrix.map(([name, ...cells]) => `<tr><th scope="row">${esc(name)}</th>${cells.map((c) => `<td>${pct(c)}</td>`).join("")}</tr>`).join("");
  $("#shas").innerHTML = [
    '<span class="c">$</span> phitex thesis.tex &amp;&amp; tex thesis.tex',
    '<span class="c">$</span> sha256sum thesis-phitex.dvi thesis.dvi',
    '<span class="h">9f2c4e1a7b…d03e</span>  thesis-phitex.dvi',
    '<span class="h">9f2c4e1a7b…d03e</span>  thesis.dvi',
    '<span class="ok">✓ identical</span>',
  ].join("\n");
}

// charts: plain SVG, one axis each, legend + direct labels, hover tooltip, table view
const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
const series = () => (isDark() ? ["#d9762f", "#5b8fd8"] : ["#c2570c", "#366cbf"]);

interface Line { name: string; values: number[]; }
function lineChart(el: HTMLElement, o: { title: string; sub: string; xs: number[]; xLabel: string; yLabel: string; lines: Line[]; logY?: boolean; logX?: boolean; fmt: (v: number) => string }) {
  const W = 880, H = 360, m = { l: 64, r: 150, t: 20, b: 44 };
  const [c0, c1] = series();
  const cols = [c0, c1];
  const all = o.lines.flatMap((l) => l.values);
  const lx = (v: number) => (o.logX ? Math.log10(v) : v);
  const ly = (v: number) => (o.logY ? Math.log10(v) : v);
  const x0 = lx(Math.min(...o.xs)), x1 = lx(Math.max(...o.xs));
  const y0 = o.logY ? Math.floor(ly(Math.min(...all))) : 0, y1 = o.logY ? Math.ceil(ly(Math.max(...all))) : Math.ceil(Math.max(...all));
  const X = (v: number) => m.l + ((lx(v) - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((ly(v) - y0) / (y1 - y0)) * (H - m.t - m.b);
  const yt = o.logY ? Array.from({ length: y1 - y0 + 1 }, (_, i) => 10 ** (y0 + i)) : Array.from({ length: 5 }, (_, i) => (y1 / 4) * i);
  let g = "";
  for (const t of yt) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${m.l - 10}" y="${Y(t) + 4}" text-anchor="end">${o.fmt(t)}</text>`;
  for (const x of o.xs) g += `<text class="tick" x="${X(x)}" y="${H - m.b + 20}" text-anchor="middle">${x}</text>`;
  g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  g += `<text class="tick" x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">${o.xLabel}</text>`;
  o.lines.forEach((l, k) => {
    const d = l.values.map((v, i) => `${i ? "L" : "M"}${X(o.xs[i])},${Y(v)}`).join("");
    g += `<path d="${d}" fill="none" stroke="${cols[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    l.values.forEach((v, i) => (g += `<circle cx="${X(o.xs[i])}" cy="${Y(v)}" r="4" fill="${cols[k]}" stroke="${css("--card")}" stroke-width="2"/>`));
    const last = l.values.at(-1)!;
    g += `<text class="dlabel" x="${W - m.r + 12}" y="${Y(last) + 4}">${esc(l.name)} · ${o.fmt(last)}</text>`;
  });
  g += `<line class="cross" id="${el.id}-x" y1="${m.t}" y2="${H - m.b}" x1="-10" x2="-10"/>`;
  const legend = o.lines.map((l, k) => `<span><i style="background:${cols[k]}"></i>${esc(l.name)}</span>`).join("");
  const table = `<table><thead><tr><th>${o.xLabel}</th>${o.lines.map((l) => `<th>${esc(l.name)}</th>`).join("")}</tr></thead><tbody>${o.xs.map((x, i) => `<tr><td>${x}</td>${o.lines.map((l) => `<td>${o.fmt(l.values[i])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  el.innerHTML = `<figcaption><b>${o.title}</b> <span class="ph">placeholder</span><span class="sub">${o.sub}</span></figcaption>
    <div class="legend">${legend}</div>
    <div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}"><text class="tick" x="${m.l}" y="${m.t - 6}">${o.yLabel}</text>${g}<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></svg><div class="tip" hidden></div></div>
    <details><summary>Table view</summary>${table}</details>`;
  const svg = el.querySelector("svg")!, tip = el.querySelector(".tip") as HTMLElement, cross = el.querySelector(`#${el.id}-x`)!;
  const move = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let i = 0;
    o.xs.forEach((x, k) => Math.abs(X(x) - px) < Math.abs(X(o.xs[i]) - px) && (i = k));
    cross.setAttribute("x1", String(X(o.xs[i])));
    cross.setAttribute("x2", String(X(o.xs[i])));
    tip.hidden = false;
    tip.innerHTML = `<b>${o.xs[i]} ${o.xLabel}</b>` + o.lines.map((l, k) => `<div><i style="background:${cols[k]}"></i>${esc(l.name)} <span>${o.fmt(l.values[i])}</span></div>`).join("");
    tip.style.left = `${(X(o.xs[i]) / W) * 100}%`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("x1", "-10"); cross.setAttribute("x2", "-10"); });
}

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} s` : `${v < 10 ? v.toFixed(1) : v.toFixed(0)} ms`);
function draw() {
  lineChart($("#c-latency"), {
    title: "Keystroke → page, by document size",
    sub: "Median of 11 edits, log scale. PhiTeX's edit against a full rebuild of the same document.",
    xs: DATA.latency.pages, xLabel: "pages", yLabel: "time (log)", logY: true, logX: true, fmt: ms,
    lines: [{ name: "PhiTeX edit", values: DATA.latency.phitex }, { name: "Full rebuild", values: DATA.latency.full }],
  });
  lineChart($("#c-cores"), {
    title: "Full build, scaling with cores",
    sub: "Speedup over one core, on the arXiv sample.",
    xs: DATA.cores.n, xLabel: "cores", yLabel: "speedup", fmt: (v) => `${v.toFixed(1)}×`,
    lines: [{ name: "PhiTeX", values: DATA.cores.speedup }],
  });
}
draw();
