import "./style.css";
import { $, initChrome } from "./ui.ts";
import { initReplica } from "./replica.ts";

initChrome();
initReplica();

// ── diagnostics: fill the vim window with ~ empty-line markers ──
$("#vim-pre")?.insertAdjacentHTML("beforeend", "\n" + Array.from({ length: 9 }, () => '<span class="tw">~</span>').join("\n"));

// The banner, the editors and the CLI are the README's animations (public/anim/, from the PhiTeX repo's assets/),
// in frames: each plays on its own clock, follows this page's theme, and shows the page's background through.

// ── how it works: the step in the middle of the screen plays its stage of anim/how.html ──
const howAnim = document.querySelector<HTMLIFrameElement>("#how-anim");
const steps = [...document.querySelectorAll<HTMLElement>("#how-steps li")];
if (howAnim && steps.length) {
  let on = -1;
  const show = (k: number) => {
    if (k === on) return;
    on = k;
    steps.forEach((li, i) => li.classList.toggle("on", i === k));
    howAnim.contentWindow?.postMessage({ howStage: k }, location.origin);
  };
  const seen = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && show(steps.indexOf(e.target as HTMLElement))),
    { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach((li, k) => {
    seen.observe(li);
    li.querySelector(".replay")?.addEventListener("click", () => { on = -1; show(k); });
  });
  // the frame may load after the first step is already in view
  howAnim.addEventListener("load", () => { const k = on; on = -1; if (k >= 0) show(k); });
}

// ── the logo's ribbon, out of the banner's logo and down the page; the footer's, into its logos ──
// In the banner's stage (anim/banner.html, 1600 wide): the logo (178 tall) has its stripes end at x 549, with their
// centres and widths across (ACCL's teal, lime, gold, orange, top to bottom).
type Pt = [number, number];
const BANNER = { endX: 549, logoH: 178, mid: 158.5, stripes: [[144.4, 2.8, "#00a8a4"], [151.7, 5, "#d3c72a"], [161, 7.2, "#f0b225"], [172.9, 9.6, "#f58f2d"]] as [number, number, string][] };
const ribbon = document.querySelector<SVGSVGElement>("svg.ribbon");
const bannerFrame = document.querySelector<HTMLIFrameElement>(".anim-banner iframe");
// the footer's PhiTeX logo: an <img>, put inline once fetched, so its stripes (.phx-s0..3, orange to teal, each drawn
// from the Φ's foot to the right end, pathLength 1) are where the ribbon reads its geometry and runs its flow through
let footLogo: Element | null = document.querySelector(".foot .foot-logo img");
const acclBox = document.querySelector<HTMLElement>(".foot .accl-anim");
// ACCL's wordmark (vendor/accl/accl-svg.js, viewBox 4800 wide): its mark at (x, y), scaled; its stripes cut level at
// the mark's top (y 3), each one's centre and width across there; the stripes' run, bottom left to top right (66 across
// for 94 up), which makes a width across `across` times a width square to the stripe
// and its edges that cut the stripes off at their far end: the left (x 0.58) and the foot (y 97)
const ACCL_MARK = { x: 192.82, y: 174.88, scale: 7.377, top: 3, left: 0.58, foot: 97, orangeOut: [5.225, 97] as Pt, centres: [44.41, 51.145, 59.85, 71.225], widths: [3.02, 4.41, 6.5, 9.29], across: 94 / Math.hypot(66, 94), dir: [66 / Math.hypot(66, 94), -94 / Math.hypot(66, 94)] as Pt };
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let drawn = 0, target = 0, table: number[] = [], total = 1, scrolled = still;
let pieces: { l0: number; l1: number; el: SVGPathElement; j: number }[] = [], pageEnd = 1;   // where the page's ribbon ends
let skip: [number, number][] = [];   // stretches of the page (the scrolled explanation) the ribbon runs past at once
let skipL: [number, number][] = [];  // the same, as lengths along the ribbon (fractions of it)
// a crossing in waves: its centre's samples, their place along it, and the stripes drawn on it, made again each frame
type Wave = { amp: number; s: number; len: number; perp: Pt } | null;
type Waving = { ps: Pt[]; wave: Wave[]; offs: number[]; els: SVGPathElement[]; l0: number; y0: number; y1: number };
let wavings: Waving[] = [];
const WAVE = { length: 520, speed: 70 };   // px, and px per second along the ribbon

// The ribbon's centre line through `pts`, its corners rounded with radius r, the segments in `wavy` in waves: as points
// every ~`step` px (worked out here, not measured from an SVG path, which is slow on a path this long). A wavy
// segment's samples lie on its straight line and carry where they are along it; the wave is laid on each frame.
function centreSamples(pts: Pt[], r: number, wavy: Map<number, number>, step: number) {
  const out: Pt[] = [pts[0]], wave: Wave[] = [null];
  const line = (a: Pt, b: Pt, amp?: number) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / step)), perp: Pt = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    for (let i = 1; i <= n; i++) { out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); wave.push(amp ? { amp, s: len * i / n, len, perp } : null); }
  };
  const dir = (a: Pt, b: Pt): Pt => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const ds = pts.slice(1).map((p, k) => dir(pts[k], p));
  let cur = pts[0];
  for (let k = 1; k < pts.length - 1; k++) {
    const v = pts[k], a = ds[k - 1], b = ds[k], cw = a[0] * b[1] - a[1] * b[0] > 0;
    const turn = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))), t = r * Math.tan(turn / 2);
    const t1: Pt = [v[0] - a[0] * t, v[1] - a[1] * t];
    line(cur, t1, wavy.get(k - 1));
    // the arc: its centre a radius off the incoming line, on the side it turns to
    const side = cw ? 1 : -1, c: Pt = [t1[0] - a[1] * r * side, t1[1] + a[0] * r * side];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]), n = Math.max(2, Math.ceil(r * turn / step));
    for (let i = 1; i <= n; i++) { const ang = a0 + side * turn * i / n; out.push([c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]); wave.push(null); }
    cur = [v[0] + b[0] * t, v[1] + b[1] * t];
  }
  line(cur, pts[pts.length - 1], wavy.get(pts.length - 2));
  return { ps: out, wave };
}
// a wave's offset at a sample at time `sec`: it travels along the crossing, out of the straight at both ends
const smooth = (x: number) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
function waveAt(w: Exclude<Wave, null>, sec: number) {
  const ramp = Math.min(WAVE.length, w.len / 3);
  return w.amp * smooth(w.s / ramp) * smooth((w.len - w.s) / ramp) * Math.sin(2 * Math.PI * (w.s - WAVE.speed * sec) / WAVE.length);
}
// a stripe's points along samples `ps` (offset o across the line, from each sample's neighbours)
function stripeD(ps: Pt[], o: (i: number) => number) {
  return "M" + ps.map((p, i) => {
    const q = ps[Math.min(ps.length - 1, i + 1)], b = ps[Math.max(0, i - 1)], tl = Math.hypot(q[0] - b[0], q[1] - b[1]) || 1, k = o(i);
    return `${(p[0] + k * (q[1] - b[1]) / tl).toFixed(1)} ${(p[1] - k * (q[0] - b[0]) / tl).toFixed(1)}`;
  }).join(" L");
}
// the logo's stripes on the page, teal first: where each leaves the Φ's foot and which way, its right end, its width
// and length, and its paths (the colour and its outline)
function logoStripes(svg: SVGSVGElement, box: DOMRect) {
  return BANNER.stripes.map((_, j) => {
    const els = [...svg.querySelectorAll<SVGPathElement>(`.phx-s${3 - j}`)];
    const p = els.reduce((a, b) => (+b.getAttribute("stroke-width")! < +a.getAttribute("stroke-width")! ? b : a));
    const m = p.getScreenCTM()!, k = Math.hypot(m.a, m.b), L = p.getTotalLength();
    const at = (l: number): Pt => { const q = p.getPointAtLength(l); return [m.a * q.x + m.c * q.y + m.e - box.left, m.b * q.x + m.d * q.y + m.f - box.top]; };
    const foot = at(0), on = at(Math.min(L, 6)), dl = Math.hypot(on[0] - foot[0], on[1] - foot[1]);
    const r = +(p.getAttribute("d")!.match(/A([\d.]+)/)?.[1] ?? 0) * k;
    return { foot, dir: [(on[0] - foot[0]) / dl, (on[1] - foot[1]) / dl] as Pt, end: at(L), w: +p.getAttribute("stroke-width")! * k, r };
  });
}
let logos: { acclAt: number; at: number } | null = null;
let clip: { top: number; left: number; foot: number } | null = null;   // below `top`, the ribbon is only right of `left` and above `foot`
function layRibbon() {
  if (!ribbon || !bannerFrame || !ribbon.getBoundingClientRect().width) return;
  logos = null; clip = null;
  const main = ribbon.parentElement as HTMLElement, box = main.getBoundingClientRect(), f = bannerFrame.getBoundingClientRect();
  const sc = f.width / 1600, ox = f.left - box.left, oy = f.top - box.top, W = box.width, rel = (r: DOMRect) => r.top - box.top;
  // its runs down the page keep close to the text's column (1240 wide), however wide the window
  const cy = oy + BANNER.mid * sc, gutter = Math.max(28, (W - Math.min(W, 1240)) / 2 - 36);
  const L = gutter, R = W - gutter, r = 70 * Math.max(0.6, sc);
  const half = Math.max(...BANNER.stripes.map(([y, w]) => Math.abs(BANNER.mid - y) + w / 2));   // stage units
  // across the page in the empty band above a plain (unshaded) section's first line, where there is room; down the
  // margins between, behind the shaded sections (they sit above it)
  const across = [...document.querySelectorAll<HTMLElement>("main > section:not(.band):not(.banner-hero)")].flatMap((e) => {
    const top = rel(e.getBoundingClientRect()), head = rel((e.firstElementChild as HTMLElement).getBoundingClientRect()) - top - 16;
    return head > 2 * half * sc + 24 ? [{ y: top + head / 2, room: head - 2 * half * sc }] : [];
  });
  const pts: Pt[] = [[ox + BANNER.endX * sc - 2, cy], [R, cy]], wavy = new Map<number, number>();
  across.forEach(({ y, room }, k) => {   // every other crossing waves, as high as its room allows
    const [a, b] = k % 2 ? [L, R] : [R, L]; pts.push([a, y], [b, y]);
    if (k % 2 && room > 24) wavy.set(pts.length - 2, Math.min(16, room / 2 - 4));
  });
  // The page's ribbon ends out of sight, behind the last shaded section (the FAQ). The footer has a ribbon of its own:
  // in from the page's right edge, straight into the PhiTeX logo's right end (teal on top, as the logo has it); the
  // logo's stripes carry it to the Φ's foot; from there straight on, down along the slant, into the top of ACCL's
  // stripes, its stripes moving over from the PhiTeX logo's spacing to ACCL's on the way. No bends, every stripe meets
  // its own colour (the footer ribbon's stripes are in the other order of travel, so `flip`), and both ends tuck a few
  // px under the logos, which sit above it.
  let H = box.height;
  // (on a narrow screen, only the footer's: the page's columns leave the ribbon no margins to run down)
  type Leg = { pts: Pt[]; r: number; wavy: Map<number, number>; scale: number; after: number; flip?: boolean; page?: boolean; lanes?: (t: number) => [number, number][] };
  const narrow = W < 1000;
  const legs: Leg[] = [];
  const last = [...document.querySelectorAll<HTMLElement>("main > section.band")].pop();
  // the logos are painted at whole pixels: put their box on one, so that where they are drawn is where they are measured
  const fl = footLogo?.parentElement;
  if (fl) { fl.style.transform = ""; const q = fl.getBoundingClientRect(); fl.style.transform = `translate(${(Math.round(q.left) - q.left).toFixed(3)}px, ${(Math.round(q.top) - q.top).toFixed(3)}px)`; }
  const stripes = footLogo instanceof SVGSVGElement ? logoStripes(footLogo, box) : null;
  if (stripes && acclBox && last) {
    pts.push([pts[pts.length - 1][0], rel(last.getBoundingClientRect()) + last.offsetHeight * 0.6]);
    if (!narrow) legs.push({ pts, r, wavy, after: 0, scale: sc, page: true });
    // The footer's ribbon is the logos' stripes (theirs are hidden, style.css): in from beyond the right edge along
    // the PhiTeX logo's stripes, round their corner and out of the Φ's foot, its stripes moving over to ACCL's spacing
    // on the way down to ACCL's top, and through where ACCL's stripes are, cut off where they are (`clip`, the mark's
    // left edge and foot). Where the logo's letters are cut for a stripe to pass over them, the ribbon shows through.
    const mid = (p: Pt[]): Pt => [(p[0][0] + p[3][0]) / 2, (p[0][1] + p[3][1]) / 2], u = stripes[0].dir;
    const E = mid(stripes.map((t) => t.end)), F0 = mid(stripes.map((t) => t.foot));
    const tc = (E[1] - F0[1]) / u[1], C: Pt = [F0[0] + u[0] * tc, F0[1] + u[1] * tc];   // the corner, on the centre line
    const rc = (stripes[0].r + stripes[3].r) / 2;
    const ab = acclBox.getBoundingClientRect(), wu = ab.width / 4800, am = wu * ACCL_MARK.scale, v = ACCL_MARK.dir, dn: Pt = [-v[0], -v[1]];
    const acc = ACCL_MARK.centres.map((x): Pt => [ab.left - box.left + wu * ACCL_MARK.x + x * am, rel(ab) + wu * ACCL_MARK.y + ACCL_MARK.top * am]);
    const A0 = mid(acc);
    const foot = footLogo!.closest("footer")!;
    H = rel(foot.getBoundingClientRect()) + foot.offsetHeight;
    const mo: Pt = [ab.left - box.left + wu * ACCL_MARK.x, rel(ab) + wu * ACCL_MARK.y], oo = ACCL_MARK.orangeOut;
    const sEnd = ((mo[0] + oo[0] * am - A0[0]) * dn[0] + (mo[1] + oo[1] * am - A0[1]) * dn[1]) + 8;
    const B: Pt = [A0[0] + dn[0] * sEnd, A0[1] + dn[1] * sEnd];
    clip = { top: A0[1] - 2, left: mo[0] + ACCL_MARK.left * am, foot: mo[1] + ACCL_MARK.foot * am };
    // each stripe's offset across the line (+ to its right as it runs) and width: the PhiTeX logo's, then ACCL's
    const from = stripes.map((t): [number, number] => [t.end[1] - E[1], t.w]);
    const n: Pt = [dn[1], -dn[0]], to = acc.map((p, j): [number, number] => [(p[0] - A0[0]) * n[0] + (p[1] - A0[1]) * n[1], ACCL_MARK.widths[j] * ACCL_MARK.across * am]);
    const S: Pt = [W + 20, E[1]], dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    const toFoot = dist(S, C) + dist(C, F0), toAccl = toFoot + dist(F0, A0), all = toAccl + dist(A0, B);
    const lanes = (t: number) => { const e = smooth((t * all - toFoot) / (toAccl - toFoot)); return from.map(([o, w], j): [number, number] => [o + (to[j][0] - o) * e, w + (to[j][1] - w) * e]); };
    legs.push({ pts: [S, C, F0, A0, B], r: rc, wavy: new Map(), after: narrow ? 0 : 400, scale: 1, lanes });
    logos = { acclAt: toAccl, at: 0 };
  } else if (!narrow) { pts.push([pts[pts.length - 1][0], H - 40]); legs.push({ pts, r, wavy, after: 0, scale: sc, page: true }); }
  if (!legs.length) { ribbon.innerHTML = ""; pieces = []; return; }
  // the runs down the margins wave too, a little (the margin is narrow)
  const down = Math.min(10, gutter - half * sc - 8);
  const pg = legs.find((l) => l.page);
  if (pg && down > 3) pg.pts.forEach((p, k, a) => { const q = a[k + 1]; if (q && Math.abs(q[0] - p[0]) < 1 && Math.abs(q[1] - p[1]) > 300 && !pg.wavy.has(k)) pg.wavy.set(k, down); });
  ribbon.setAttribute("viewBox", `0 0 ${W} ${H}`);
  ribbon.style.height = `${H}px`;
  // Each stripe a stroked line at its offset (which may move across it along a leg; its width is the one at the
  // piece's middle: the two logos' stripes are as wide as each other to a tenth of a px), in pieces: a crossing in
  // waves is a piece of its own, made again each frame. Lengths run on along
  // the legs (the logo between them counts `after` px), and every piece's dashes count in the centre line's length
  // (pathLength), so the stripes, inner and outer on a bend, are drawn as far as each other.
  let svg = "", base = 0;
  const made: { l0: number; l1: number; j: number }[] = [], waves: Omit<Waving, "els">[] = [];
  table = [];
  pageEnd = 0;
  for (const leg of legs) {
    base += leg.after;
    const { ps, wave } = centreSamples(leg.pts, leg.r, leg.wavy, 4), cum = [0];
    for (let j = 1; j < ps.length; j++) cum.push(cum[j - 1] + Math.hypot(ps[j][0] - ps[j - 1][0], ps[j][1] - ps[j - 1][1]));
    const len = cum[cum.length - 1];
    const lane = (j: number, i: number): [number, number] => leg.lanes ? leg.lanes(cum[i] / len)[j]
      : [(leg.flip ? -1 : 1) * (BANNER.mid - BANNER.stripes[j][0]) * leg.scale, BANNER.stripes[j][1] * leg.scale];
    const cuts = [0];
    for (let i = 1; i < ps.length - 1; i++)
      if (!!wave[i] !== !!wave[i - 1]) cuts.push(i);
    cuts.push(ps.length - 1);
    for (let c = 0; c < cuts.length - 1; c++) {
      const i0 = Math.max(0, cuts[c] - 1), i1 = Math.min(ps.length - 1, cuts[c + 1] + 1), im = Math.round((i0 + i1) / 2);
      if (i1 <= i0) continue;
      const l0 = cum[i0], l1 = cum[i1], sub = ps.slice(i0, i1 + 1);
      const waving = wave.slice(i0, i1 + 1).some(Boolean);
      if (waving) waves.push({ ps: sub, wave: wave.slice(i0, i1 + 1), offs: BANNER.stripes.map((_, j) => lane(j, im)[0]), l0: base + l0,
        y0: Math.min(...sub.map((p) => p[1])) - 40, y1: Math.max(...sub.map((p) => p[1])) + 40 });
      BANNER.stripes.forEach(([, , colour], j) => {
        const dd = stripeD(sub, (i) => lane(j, i0 + i)[0]);
        svg += `<path d="${dd}" stroke="${colour}" stroke-width="${lane(j, im)[1].toFixed(2)}" pathLength="${(l1 - l0).toFixed(1)}" stroke-dasharray="0 ${(l1 - l0 + 1).toFixed(1)}"${waving ? ` data-wave="${waves.length - 1}"` : ""}/>`;
        made.push({ l0: base + l0, l1: base + l1, j });
      });
    }
    // the length along the ribbon at which it first reaches each 10 px down the page (the first leg; the rest is the
    // footer, reached at the page's end)
    if (leg.page) ps.forEach((p, i) => { const y = Math.floor(p[1] / 10); while (table.length <= y) table.push(cum[i]); });
    base += len;
    if (leg.page) pageEnd = base;
    else if (logos) logos.at = base - len + logos.acclAt;   // where it reaches ACCL's top
  }
  total = base;
  pageEnd /= total;
  table = table.map((l) => l / total);
  ribbon.innerHTML = clip ? `<defs><clipPath id="ribbon-end"><rect x="-50" y="-50" width="${W + 100}" height="${clip.top + 50}"/><rect x="${clip.left.toFixed(2)}" y="${clip.top - 1}" width="${W + 50}" height="${(clip.foot - clip.top + 1).toFixed(2)}"/></clipPath></defs><g clip-path="url(#ribbon-end)">${svg}</g>` : svg;
  const els = [...ribbon.querySelectorAll("path")];
  pieces = made.map((m, i) => ({ ...m, el: els[i] }));
  wavings = waves.map((w, k) => ({ ...w, els: els.filter((e) => e.dataset.wave === String(k)) }));
  logoLengths = flowLengths();
  // the explanation scrolls a long way beside its pinned animation: the ribbon runs past it at once
  skip = [...document.querySelectorAll<HTMLElement>(".how-scrolly")].map((e) => { const t = rel(e.getBoundingClientRect()); return [t - 200, t + e.offsetHeight]; });
  const lenAt = (y: number) => table.length ? table[Math.max(0, Math.min(table.length - 1, Math.floor(y / 10)))] : 0;
  skipL = skip.map(([a, b]) => [lenAt(a), lenAt(b)]);
  ribbonTarget(); drawn = Math.min(drawn, target); wake();
}
function ribbonTarget() {
  if (!ribbon || !pieces.length) return;
  const max = document.documentElement.scrollHeight - innerHeight;
  // (it reaches 0.8 of a screen ahead of the top, that lead growing over the first half screen scrolled, so the first
  // scroll does not throw it out a screen at once)
  let y = scrollY + innerHeight * 0.8 * Math.min(1, scrollY / (innerHeight * 0.5)) - (ribbon.getBoundingClientRect().top + scrollY);
  for (const [a, b] of skip) if (y > a && y < b) y = b;
  // it waits for the first scroll, then follows what you have read; back at the top it draws back into the logo; at the
  // bottom it reaches the footer's logo
  const feet = footLogo?.getBoundingClientRect(), atFoot = (feet && feet.bottom < innerHeight) || scrollY >= max - 4;
  target = !scrolled || (!still && scrollY < 8) ? 0 : atFoot ? 1
    : table.length ? Math.min(pageEnd, table[Math.max(0, Math.min(table.length - 1, Math.floor(y / 10)))]) : 0;
}
// It flows on from the banner's logo: as each edit lands there, every stripe drains out through the logo's end and
// fills in again behind, a stripe after another (orange first, 0.08 s apart; 0.28 s to drain, 0.28 s to fill: banner.html's
// render). Here the stripe runs on, so the drained length (the logo's stripe, in px) goes on down the ribbon as a gap at
// the speed it left the logo, timed by the banner's own clock.
const DRAIN = { lead: -0.2 + 0.28, stagger: 0.08, half: 0.28 };
let logoLengths: number[] = [];   // the banner logo's stripes, in this page's px, teal first
type Clock = { origin: number; D: number; ends: number[] };
const bannerClock = (): Clock | null => { try { return (bannerFrame?.contentWindow as unknown as { bannerClock?: () => Clock })?.bannerClock?.() ?? null; } catch { return null; } };
function flowLengths() {
  try {
    const doc = bannerFrame!.contentDocument!;
    return BANNER.stripes.map((_, j) => {
      const p = [...doc.querySelectorAll<SVGPathElement>(`#logo .phx-s${3 - j}`)].find((e) => e.ownerSVGElement!.getBoundingClientRect().width > 0);
      if (!p) return 0;
      const s = p.ownerSVGElement!;
      return p.getTotalLength() * s.getBoundingClientRect().width / s.viewBox.baseVal.width;
    });
  } catch { return []; }
}
// the gaps on stripe j at time `now` (ms, this page's clock), as [start, end] along the ribbon; and when the next one starts
function gaps(now: number) {
  const ck = bannerClock(), out: [number, number][][] = BANNER.stripes.map(() => []);
  if (still || !ck || logoLengths.length !== 4 || !logoLengths[0]) return { out, next: Infinity };
  const tb = (performance.timeOrigin + now - ck.origin) / 1000;
  let next = Infinity;
  BANNER.stripes.forEach((_, j) => {
    const v = logoLengths[j] / DRAIN.half, life = total / v + DRAIN.half, lag = DRAIN.lead + (3 - j) * DRAIN.stagger;
    for (let loop = Math.floor((tb - life) / ck.D) - 1; loop <= Math.floor(tb / ck.D) + 1; loop++)
      for (const e of ck.ends) {
        const a = tb - (loop * ck.D + e + lag);
        if (a < 0) { next = Math.min(next, -a); continue; }
        if (a < life) out[j].push([Math.max(0, (a - DRAIN.half) * v), a * v]);
      }
    out[j].sort((x, y) => x[0] - y[0]);
  });
  return { out, next };
}
function paintRibbon(now: number) {
  if (!pieces.length) return { busy: false, next: Infinity };
  const D = drawn * total, { out, next } = gaps(now);
  let busy = false;
  for (const { l0, l1, el, j } of pieces) {
    // what of [l0, l1] is drawn: up to D, less the gaps; as dashes and gaps counted from l0, then the rest blank
    const len = l1 - l0, a = Math.min(len, Math.max(0, D - l0)), dash: number[] = [];
    let at = 0;
    for (const [g0, g1] of out[j]) {
      const s = Math.max(at, Math.min(a, g0 - l0)), e = Math.max(at, Math.min(a, g1 - l0));
      if (e > s) { dash.push(s - at, e - s); at = e; busy = true; }
    }
    dash.push(a - at, len + 1);
    el.style.strokeDasharray = dash.map((x) => x.toFixed(1)).join(" ");
  }
  // the crossings in waves that are drawn and on screen move
  if (!still && wavings.length) {
    const top = ribbon!.getBoundingClientRect().top, sec = now / 1000;
    for (const w of wavings) {
      if (w.l0 > D || w.y1 + top < 0 || w.y0 + top > innerHeight) continue;
      const ps = w.ps.map((p, i): Pt => { const wv = w.wave[i]; if (!wv) return p; const k = waveAt(wv, sec); return [p[0] + wv.perp[0] * k, p[1] + wv.perp[1] * k]; });
      w.els.forEach((el, j) => el.setAttribute("d", stripeD(ps, () => w.offs[j])));
      busy = true;
    }
  }
  return { busy, next };
}
// frames only while it grows, flows or waves, and only while the tab is shown; otherwise it sleeps until the next flow
let awake = false, nap = 0, acclLaunched = false, last = 0;
// px per second at most, drawn out (twice that drawn back), while its end is in the page's first 1.5 screens (the
// first scroll) or running past the scrolled explanation; elsewhere it eases straight to where you are, however far
// you jumped
const GROW = 1800, GROW_PAST = 1000;   // (the second past the explanation, which it would otherwise cross at once)
function step(now: number) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60, d = (target - drawn) * 0.06;
  last = now;
  const past = skipL.some(([a, b]) => drawn >= a - 0.002 && drawn <= b);
  const cap = past ? GROW_PAST * dt / total : drawn * total < innerHeight * 1.5 ? GROW * dt / total : Infinity;
  drawn += Math.max(-2 * cap, Math.min(cap, d));
  if (Math.abs(target - drawn) < 1e-4) drawn = target;
  const { busy, next } = paintRibbon(now);
  if (!acclLaunched && (logos ? drawn * total >= logos.at : drawn > 0.999)) { acclLaunched = true; acclArrive(); }
  if (!document.hidden && (drawn !== target || busy)) { requestAnimationFrame(step); return; }
  awake = false; last = 0;
  if (drawn > 0.01 && next < Infinity) nap = window.setTimeout(wake, next * 1000 + 20);
}
function wake() { clearTimeout(nap); if (!awake) { awake = true; requestAnimationFrame(step); } }
addEventListener("scroll", () => { scrolled = true; ribbonTarget(); wake(); }, { passive: true });
document.addEventListener("visibilitychange", wake);
let relay = 0;
const relayOut = () => { clearTimeout(relay); relay = window.setTimeout(layRibbon, 150); };
addEventListener("resize", relayOut);
addEventListener("load", layRibbon);
if (footLogo instanceof HTMLImageElement) fetch(footLogo.src).then((r) => r.text()).then((t) => {
  const svg = document.importNode(new DOMParser().parseFromString(t, "image/svg+xml").documentElement, true) as unknown as SVGSVGElement;
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.classList.add("phx-logo"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "PhiTeX");
  footLogo!.replaceWith(svg); footLogo = svg; relayOut();
});
bannerFrame?.addEventListener("load", relayOut);
new ResizeObserver(relayOut).observe(document.querySelector("main")!);

// ── ACCL's logo in the footer: it launches (ACCL's own intro, from ammar.engineer/web/accl-logo, in public/vendor/accl)
// when the ribbon arrives. The scripts load only as the footer comes near.
let accl: Promise<{ tl: { play(): void; progress(p: number): void } }> | null = null;
const load = (src: string) => new Promise<void>((ok, no) => { const e = document.createElement("script"); e.src = src; e.onload = () => ok(); e.onerror = no; document.head.append(e); });
function acclReady() {
  if (!accl && acclBox) accl = load("/vendor/accl/gsap.min.js").then(() => load("/vendor/accl/accl-svg.js")).then(() => load("/vendor/accl/accl-anim.js")).then(() => {
    const A = (window as unknown as { ACCL: { mount(e: HTMLElement, o: object): SVGSVGElement; intro(s: SVGSVGElement, o: object): { play(): void; progress(p: number): void } } }).ACCL;
    const svg = A.mount(acclBox, { logo: "wordmark", theme: "dark", background: false });
    const tl = A.intro(svg, { style: "launch", from: "top" });
    // no motion wanted, or no ribbon to arrive by (narrow screens): it is there from the start
    if (still || !ribbon?.getBoundingClientRect().width) { tl.progress(1); acclBox!.style.opacity = "1"; }
    return { tl };   // wrapped: a GSAP timeline is thenable, and a promise would wait for it to finish
  });
  return accl;
}
// it waits unseen (the intro's first frame is its pieces scattered) until the footer's ribbon reaches it, then its
// stripes shoot in from above, on along the ribbon, and the rest follows
function acclArrive() { acclReady()?.then(({ tl }) => { acclBox!.style.opacity = "1"; tl.play(); }); }
if (acclBox) {
  new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) acclReady(); }, { rootMargin: "800px 0px" }).observe(acclBox);
}
