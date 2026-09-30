import "./style.css";
import { PRESETS } from "./demo/presets.ts";
import { blockAt, blocks, highlight, typeset } from "./fake.ts";
import { REPO } from "./links.ts";
import phiTex from "./content/phi.tex?raw";
import phiSsa from "./content/phi.ssa?raw";

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Runs `f` while `el` is on screen (for the looping animations). */
function whileVisible(el: Element, f: (alive: () => boolean) => Promise<void>) {
  let on = false;
  let running = false;
  new IntersectionObserver(([e]) => {
    on = e.isIntersecting;
    if (on && !running) {
      running = true;
      f(() => on).finally(() => (running = false));
    }
  }, { threshold: 0.25 }).observe(el);
}

// ── theme ──
$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("theme", root.dataset.theme);
  } catch {}
});
const nav = $("#nav");
addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 20), { passive: true });

// ── reveal ──
const rev = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), rev.unobserve(e.target))),
  { rootMargin: "0px 0px -8% 0px" },
);
$$(".reveal").forEach((el) => {
  // (siblings rise one after another)
  const sibs = [...(el.parentElement?.children ?? [])].filter((c) => c.classList.contains("reveal"));
  el.style.setProperty("--i", String(Math.max(0, sibs.indexOf(el))));
  rev.observe(el);
});

// ── the demo: the Overleaf replica, editable (DESIGN MOCK: fake.ts) ──
const src = $<HTMLTextAreaElement>("#src");
const hl = $("#hl");
const gutter = $("#gutter");
const page = $("#r-page");
const pdfPane = $(".r-pdf");
const sw = $("#r-switch");
const rec = $("#r-recompile");
let preset = PRESETS[0];
let prev = "";
let hot = -1;
let hotTimer = 0;
let instant = false;
let stale = false;

function paintEditor() {
  hl.innerHTML = highlight(src.value, instant ? hot : -1);
  gutter.textContent = Array.from({ length: src.value.split("\n").length }, (_, i) => i + 1).join("\n");
  src.style.height = hl.offsetHeight + "px";
}

function render(changedAt?: number) {
  const t0 = performance.now();
  const t = typeset(src.value, { runhead: preset.id === "book" });
  page.innerHTML = t.html;
  if (changedAt !== undefined) {
    hot = blockAt(src.value, changedAt);
    page.querySelector(`.ch[data-b="${hot}"]`)?.classList.add("hot");
    clearTimeout(hotTimer);
    hotTimer = window.setTimeout(() => {
      page.querySelectorAll(".ch.hot").forEach((e) => e.classList.remove("hot"));
      hot = -1;
      paintEditor();
    }, 700);
  }
  $("#s-chunks").textContent = `${changedAt === undefined ? 0 : 1} of ${t.chunks.toLocaleString()}`;
  requestAnimationFrame(() => {
    if (changedAt !== undefined) $("#lat").textContent = Math.max(1, performance.now() - t0).toFixed(0);
  });
}

function setInstant(on: boolean) {
  instant = on;
  sw.classList.toggle("inst", on);
  sw.setAttribute("aria-checked", String(on));
  pdfPane.classList.toggle("instant", on);
  rec.classList.toggle("off", on);
  if (on && stale) recompile();
}
function setStale(on: boolean) {
  stale = on;
  pdfPane.classList.toggle("stale", on);
  rec.classList.toggle("nag", on);
}
function recompile() {
  setStale(false);
  render();
}

function load(id: string) {
  preset = PRESETS.find((p) => p.id === id)!;
  src.value = preset.files[preset.open];
  prev = src.value;
  $("#r-tab").textContent = $(`.r-file[data-preset="${id}"]`).firstChild!.textContent!.trim();
  $("#editor").scrollTop = 0;
  setStale(false);
  render();
  paintEditor();
  $$(".r-file[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === id));
}

let userTyped = false;
src.addEventListener("input", () => {
  const now = src.value;
  let a = 0;
  while (a < prev.length && a < now.length && prev[a] === now[a]) a++;
  prev = now;
  if (instant) render(a);
  else setStale(true);
  paintEditor();
});
let autoDirty = false;
const takeOver = () => {
  if (userTyped) return;
  userTyped = true;
  // (the auto-typing stops mid-word: give the reader the example as it was)
  if (autoDirty) {
    src.value = preset.files[preset.open];
    prev = src.value;
    render();
    paintEditor();
  }
  setInstant(true);
};
src.addEventListener("keydown", takeOver);
src.addEventListener("pointerdown", takeOver);
sw.addEventListener("click", () => {
  userTyped = true;
  setInstant(!instant);
});
rec.addEventListener("click", recompile);
$$(".r-file[data-preset]").forEach((b) =>
  b.addEventListener("click", () => {
    userTyped = true;
    load(b.dataset.preset!);
  }),
);
load("article");

// Until the reader takes over: type in PDF mode (stale), flip to Instant, type on.
async function autotype() {
  const at = () => src.value.indexOf("Everything on the page");
  const type = async (text: string) => {
    for (const ch of text) {
      if (userTyped) return false;
      const pos = at();
      src.value = src.value.slice(0, pos) + ch + src.value.slice(pos);
      autoDirty = true;
      src.dispatchEvent(new Event("input"));
      await sleep(50 + Math.random() * 80);
    }
    return true;
  };
  if (reduced.matches) return setInstant(true);
  await sleep(1400);
  if (!(await type("With Recompile, "))) return;
  await sleep(1200);
  if (userTyped) return;
  setInstant(true);
  await sleep(900);
  if (!(await type("but not with PhiTeX. "))) return;
}
autotype();

// ── how it works: the scrolly pipeline ──
const pipe = $("#pipe") as unknown as SVGSVGElement;
const ys = [60, 185, 310, 435, 560];
function step(k: number) {
  $$(".step").forEach((s) => s.classList.toggle("on", Number(s.dataset.step) === k));
  pipe.querySelectorAll<SVGGElement>(".node").forEach((n) => {
    const i = Number(n.dataset.step);
    n.classList.toggle("on", i <= k);
    n.classList.toggle("cur", i === k);
  });
  ($("#spine-lit") as unknown as SVGPathElement).style.strokeDashoffset = String(500 * (1 - k / 4));
  pipe.querySelector(".pulse")!.setAttribute("cy", String(ys[k]));
  pipe.classList.toggle("loop", k === 4);
}
const stepIO = new IntersectionObserver(
  (es) => es.forEach((e) => e.isIntersecting && step(Number((e.target as HTMLElement).dataset.step))),
  { rootMargin: "-45% 0px -45% 0px" },
);
$$(".step").forEach((s) => stepIO.observe(s));
step(0);

// ── one keystroke: the chunk grid (an illustration of the rule) ──
const grid = $("#ks-grid");
const N = 240;
grid.innerHTML = Array.from({ length: N }, (_, k) => `<i style="--d:${(k % 20) * 18 + Math.floor(k / 20) * 30}"></i>`).join("");
const cells = $$("i", grid);
new IntersectionObserver(([e], io) => {
  if (e.isIntersecting) {
    grid.classList.add("in");
    io.disconnect();
  }
}, { threshold: 0.3 }).observe(grid);
let mode = "word";
$$("[data-ks]").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.ks!;
    $$("[data-ks]").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
  }),
);
const flash = (i: number, cls: "hot" | "check", ms = 40) => {
  cells[i]?.classList.add(cls);
  setTimeout(() => cells[i]?.classList.remove(cls), ms);
};
whileVisible(grid, async (alive) => {
  while (alive()) {
    if (reduced.matches) {
      cells[97].classList.add("hot");
      return;
    }
    if (mode === "word") {
      const i = 20 + Math.floor(Math.random() * 200);
      flash(i, "hot", 60);
      for (let k = 1; k <= 3; k++) {
        await sleep(70);
        flash(i + k, "check", 50);
      }
      await sleep(1300);
    } else if (mode === "macro") {
      const d = 12;
      flash(d, "hot", 60);
      for (let i = d + 1; i < N && alive(); i++) {
        if (i % 17 === 3 || i % 29 === 0) flash(i, "hot", 60);
        else flash(i, "check", 30);
        if (i % 6 === 0) await sleep(16);
      }
      await sleep(1500);
    } else {
      const l = 64;
      flash(l, "hot", 60);
      await sleep(220);
      // the page (its output chunk), then μ: the .aux changed, its readers rebuilt
      for (const i of [180, 181]) flash(i, "hot", 60);
      await sleep(260);
      for (const i of [31, 142, 203]) {
        flash(i, "hot", 60);
        await sleep(140);
      }
      await sleep(1500);
    }
  }
});

// ── tiers ──
$$(".tier .bits").forEach((b) => (b.innerHTML = "<i></i>".repeat(Number(b.dataset.n))));
whileVisible($(".tier-grid"), async (alive) => {
  const tiers = $$(".tier:not(.later) .bits").map((b) => $$("i", b));
  while (alive() && !reduced.matches) {
    const aux = Math.random() < 0.4;
    for (let t = 0; t < 4; t++) {
      if (t === 3 && !aux) break;
      const bits = tiers[t];
      const i = Math.floor(Math.random() * bits.length);
      bits[i].classList.add("hot");
      setTimeout(() => bits[i].classList.remove("hot"), 90);
      await sleep(180);
      const j = (i + 1) % bits.length;
      bits[j].classList.add("stop");
      setTimeout(() => bits[j].classList.remove("stop"), 90);
      await sleep(260);
    }
    if (aux) {
      const b = tiers[0][Math.floor(Math.random() * tiers[0].length)];
      b.classList.add("hot");
      setTimeout(() => b.classList.remove("hot"), 90);
    }
    await sleep(1300);
  }
});

// ── the SSA listing: phi.tex ↔ phi.ssa ──
{
  const texLines = phiTex.replace(/\n$/, "").split("\n");
  $("#ssa-tex").innerHTML = texLines.map((l, i) => `<span class="ln" tabindex="0" data-l="${i + 1}">${esc(l) || " "}</span>`).join("");
  let cur = 0;
  const color = (l: string) =>
    esc(l)
      .replace(/^(; l\.\d+.*)$/, '<span class="h">$1</span>')
      .replace(/(\s;\s.*)$/, '<span class="c">$1</span>')
      .replace(/(%\d+)/g, '<span class="v">$1</span>')
      .replace(/φ/g, '<span class="phi">φ</span>')
      .replace(/\b(prim \w+|catcodes \w+|undefined \\\w+|page builder)/g, '<span class="p">$1</span>');
  $("#ssa-ir").innerHTML = phiSsa
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => {
      const m = l.match(/^; l\.(\d+)/);
      if (m) cur = Number(m[1]);
      return `<span class="ln" data-l="${cur}">${color(l) || " "}</span>`;
    })
    .join("");
  const pair = $(".ssa-pair");
  const on = (l: string | null) => {
    pair.classList.toggle("focus", !!l);
    $$(".ssa-pair .ln").forEach((x) => x.classList.toggle("on", x.dataset.l === l));
    const first = l && $(`#ssa-ir .ln[data-l="${l}"]`);
    if (first) {
      const box = $("#ssa-ir");
      box.scrollTo({ top: first.offsetTop - box.offsetTop - 16, behavior: reduced.matches ? "auto" : "smooth" });
    }
  };
  $$("#ssa-tex .ln").forEach((x) => {
    x.addEventListener("mouseenter", () => on(x.dataset.l!));
    x.addEventListener("focus", () => on(x.dataset.l!));
  });
  $("#ssa-tex").addEventListener("mouseleave", () => on(null));
}

// ── links ──
{
  const watch = $<HTMLAnchorElement>("#watch");
  if (REPO) watch.href = REPO;
  else watch.hidden = true;
}

// ── everywhere: Overleaf, VS Code and the CLI, side by side, each running ──
{
  const sec = $("#everywhere");
  
  // each face types, repaints and runs, while on screen
  const tex = String.raw`\documentclass{article}
\begin{document}
\section{Results}
`;
  const lines = ["Every edit rebuilds only the chunks it touched. ", "The page repaints before the rest of the document catches up."];
  const hl = (t: string, caret: boolean) =>
    esc(t).replace(/(\\[A-Za-z]+)/g, '<span class="cs">$1</span>').replace(/([{}])/g, '<span class="br">$1</span>') + (caret ? '<span class="caret"></span>' : "");
  for (const kind of ["ol", "vs"]) {
    const ed = $(`.ed[data-type="${kind}"]`, sec);
    const pg = $(`.pv-page[data-page="${kind}"]`, sec);
    const chip = $(`.face.f${kind === "ol" ? 0 : 1} .pv-chip b`, sec);
    const put = (t: string, hot: boolean) => {
      ed.innerHTML = hl(t, true);
      pg.innerHTML = typeset(t).html;
      if (hot) {
        const cs = pg.querySelectorAll(".ch");
        cs[cs.length - 1]?.classList.add("hot");
        setTimeout(() => pg.querySelectorAll(".ch.hot").forEach((c) => c.classList.remove("hot")), 60);
      }
    };
    put(tex + lines.join(""), false);
    whileVisible(ed, async (alive) => {
      while (alive() && !reduced.matches) {
        let t = tex;
        put(t, false);
        await sleep(600);
        for (const ch of lines.join("")) {
          if (!alive()) return;
          t += ch;
          put(t, true);
          // (DESIGN PREVIEW: a figure in the report's measured range)
          chip.textContent = String(5 + Math.floor(Math.random() * 7));
          await sleep(40 + Math.random() * 70);
        }
        await sleep(2600);
      }
    });
  }
  const tty = $("#tty");
  const ssaLines = phiSsa.split("\n").slice(0, 40);
  const colorTty = (l: string) =>
    esc(l)
      .replace(/^(; l\.\d+.*)$/, '<span class="h">$1</span>')
      .replace(/(\s;\s.*)$/, '<span class="c">$1</span>')
      .replace(/(%\d+)/g, '<span class="v">$1</span>')
      .replace(/φ/g, '<span class="phi">φ</span>');
  const cmd = "phitex --ssa examples/phi.tex";
  tty.innerHTML = `<span class="pt">$</span> ${cmd}\n` + ssaLines.map(colorTty).join("\n");
  whileVisible(tty, async (alive) => {
    while (alive() && !reduced.matches) {
      let out = '<span class="pt">$</span> ';
      for (const ch of cmd) {
        if (!alive()) return;
        out += esc(ch);
        tty.innerHTML = out + '<span class="caret-b">▌</span>';
        await sleep(30 + Math.random() * 40);
      }
      out += "\n";
      await sleep(400);
      const shown: string[] = [];
      for (const l of ssaLines) {
        if (!alive()) return;
        shown.push(colorTty(l));
        tty.innerHTML = out + shown.slice(-22).join("\n");
        await sleep(55);
      }
      await sleep(3000);
    }
  });
}
