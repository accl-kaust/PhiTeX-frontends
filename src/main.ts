import "./style.css";
import { PRESETS } from "./demo/presets.ts";
import { blockAt, blocks, highlight, typeset } from "./fake.ts";
import { REPOS } from "./links.ts";
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
$$(".reveal").forEach((el) => rev.observe(el));

// ── the demo (DESIGN PREVIEW: fake.ts, not the core) ──
const src = $<HTMLTextAreaElement>("#src");
const hl = $("#hl");
const gutter = $("#gutter");
const paper = $("#paper");
const viewer = $("#viewer");
const editor = $("#editor");
let preset = PRESETS[0];
let prev = "";
let hot = -1;
let edits = 0;
let builds = 0;
let hotTimer = 0;

function paintEditor() {
  hl.innerHTML = highlight(src.value, hot);
  const n = src.value.split("\n").length;
  gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  src.style.height = hl.offsetHeight + "px";
}

function render(changedAt?: number) {
  const t0 = performance.now();
  const t = typeset(src.value, { runhead: preset.id === "book", pages: preset.id === "stress" ? 38 : preset.id === "book" ? 1 : 1 });
  paper.innerHTML = t.html;
  if (changedAt !== undefined) {
    hot = blockAt(src.value, changedAt);
    const el = paper.querySelector(`.ch[data-b="${hot}"]`);
    el?.classList.add("hot");
    clearTimeout(hotTimer);
    hotTimer = window.setTimeout(() => {
      paper.querySelectorAll(".ch.hot").forEach((e) => e.classList.remove("hot"));
      hot = -1;
      paintEditor();
    }, 700);
    builds++;
  }
  paintEditor();
  requestAnimationFrame(() => {
    const ms = performance.now() - t0;
    if (changedAt === undefined) return;
    $("#lat").textContent = ms.toFixed(1);
    $("#bolt").classList.remove("tick");
    void $("#bolt").offsetWidth;
    $("#bolt").classList.add("tick");
    $("#s-lat").textContent = `${ms.toFixed(1)} ms`;
    $("#s-core").textContent = `${(0.1 + Math.random() * 0.2).toFixed(2)} ms`;
    $("#s-chunks").textContent = `1 of ${t.chunks.toLocaleString()}`;
    $("#s-builds").textContent = `${edits} → ${builds}`;
  });
}

function load(id: string) {
  preset = PRESETS.find((p) => p.id === id)!;
  src.value = preset.files[preset.open];
  prev = src.value;
  edits = builds = 0;
  editor.scrollTop = 0;
  render();
  $("#s-chunks").textContent = `— of ${blocks(src.value).length.toLocaleString()}`;
  $$(".presets button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.preset === id)));
}

let userTyped = false;
src.addEventListener("input", () => {
  edits++;
  // (where the text changed: the first differing offset)
  const now = src.value;
  let a = 0;
  while (a < prev.length && a < now.length && prev[a] === now[a]) a++;
  prev = now;
  render(a);
});
src.addEventListener("keydown", () => (userTyped = true));
src.addEventListener("pointerdown", () => (userTyped = true));
$$(".presets button").forEach((b) =>
  b.addEventListener("click", () => {
    userTyped = true;
    load(b.dataset.preset!);
  }),
);
$<HTMLInputElement>("#show-chunks").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  viewer.classList.toggle("no-chunks", !on);
  editor.classList.toggle("no-chunks", !on);
});
$("#check").addEventListener("click", () => {
  const out = $("#check-out");
  out.textContent = "design preview: the real check (ph_check: incremental = fresh build) runs once the core is wired";
  out.classList.add("show");
  setTimeout(() => out.classList.remove("show"), 4000);
});
load("article");

// Types into the demo on its own until the reader does.
async function autotype() {
  await sleep(1600);
  const phrases = ["Try it: ", "Edit any word. "];
  for (const p of phrases) {
    if (userTyped || reduced.matches) return;
    const at = src.value.indexOf("Everything on the page");
    for (const ch of p) {
      if (userTyped) return;
      const pos = src.value.indexOf("Everything on the page");
      src.value = src.value.slice(0, pos) + ch + src.value.slice(pos);
      src.dispatchEvent(new Event("input"));
      await sleep(55 + Math.random() * 90);
    }
    await sleep(1400);
    for (let i = 0; i < p.length; i++) {
      if (userTyped) return;
      const pos = src.value.indexOf("Everything on the page");
      src.value = src.value.slice(0, pos - 1) + src.value.slice(pos);
      src.dispatchEvent(new Event("input"));
      await sleep(28);
    }
    void at;
    await sleep(700);
  }
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
grid.innerHTML = "<i></i>".repeat(N);
const cells = $$("i", grid);
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

// ── the Overleaf replica: PDF → ⚡ Instant (animated, not a recording) ──
{
  const code = $("#r-code");
  const page = $("#r-page");
  const pdf = $(".r-pdf");
  const sw = $("#r-switch");
  const rec = $("#r-recompile");
  const chip = $("#r-chip b");
  let text = String.raw`\documentclass{article}
\usepackage{graphicx}

\begin{document}
\section{Results}\label{res}
The instant build equals a full one after every edit.

`;
  const typed = [
    "Typing here updates the page at once, ",
    "with no Recompile. The page you look at is painted first.",
  ];
  const base = text;
  const show = (t: string, caret: boolean) => {
    code.innerHTML =
      esc(t).replace(/(\\[A-Za-z]+)/g, '<span class="cs">$1</span>').replace(/([{}])/g, '<span class="br">$1</span>') + (caret ? '<span class="caret"></span>' : "");
  };
  const paint = (t: string, hot = false) => {
    page.innerHTML = typeset(t).html;
    if (hot) page.querySelectorAll(".ch").forEach((c, i, all) => i === all.length - 1 && c.classList.add("hot"));
    if (hot) setTimeout(() => page.querySelectorAll(".ch.hot").forEach((c) => c.classList.remove("hot")), 60);
  };
  const setMode = (inst: boolean) => {
    sw.classList.toggle("inst", inst);
    pdf.classList.toggle("instant", inst);
    rec.classList.toggle("off", inst);
  };
  show(text, true);
  paint(text);
  whileVisible($("#replica"), async (alive) => {
    while (alive()) {
      text = base;
      setMode(false);
      pdf.classList.remove("stale");
      rec.classList.remove("nag");
      show(text, true);
      paint(text);
      if (reduced.matches) {
        setMode(true);
        text += typed.join("");
        show(text, false);
        paint(text);
        return;
      }
      await sleep(900);
      // PDF mode: typing leaves the page stale
      for (const ch of typed[0]) {
        text += ch;
        show(text, true);
        await sleep(45 + Math.random() * 60);
      }
      pdf.classList.add("stale");
      rec.classList.add("nag");
      await sleep(1300);
      // flip the switch
      rec.classList.remove("nag");
      setMode(true);
      await sleep(350);
      pdf.classList.remove("stale");
      paint(text, true);
      chip.textContent = "9";
      await sleep(700);
      for (const ch of typed[1]) {
        if (!alive()) return;
        text += ch;
        show(text, true);
        paint(text, true);
        // (a plausible figure within the report's measured 4.5–20 ms; DESIGN PREVIEW)
        chip.textContent = String(6 + Math.floor(Math.random() * 6));
        await sleep(45 + Math.random() * 70);
      }
      await sleep(3200);
    }
  });
}

// ── links ──
$<HTMLAnchorElement>("#watch").href = REPOS.PhiTeX;

// ── everywhere: the prism, turned by scroll ──
{
  const sec = $("#everywhere");
  const prism = $("#prism");
  const faces = (k: number) =>
    $$("[data-face]", sec).forEach((el) => el.classList.toggle("on", Number(el.dataset.face) === k));
  // (progress 0..1 → a turn that rests on each face: plateaus with eased moves between)
  const ease = (x: number) => x * x * (3 - 2 * x);
  let last = -1;
  const frame = () => {
    const r = sec.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, -r.top / (r.height - innerHeight)));
    if (p === last) return;
    last = p;
    const seg = p * 3; // 3 stops: hold, move, hold, move, hold
    const pos = seg < 0.7 ? 0 : seg < 1.3 ? ease((seg - 0.7) / 0.6) : seg < 1.7 ? 1 : seg < 2.3 ? 1 + ease((seg - 1.7) / 0.6) : 2;
    prism.style.setProperty("--turn", `${-120 * pos}deg`);
    prism.style.setProperty("--tilt", `${Math.sin(pos * Math.PI) * 4 - 2}deg`);
    faces(Math.round(pos));
  };
  if (reduced.matches) faces(-1), $$("[data-face]", sec).forEach((e) => e.classList.add("on"));
  else {
    addEventListener("scroll", () => requestAnimationFrame(frame), { passive: true });
    frame();
  }

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
  tty.innerHTML = `<span class="pr">$</span> ${cmd}\n` + ssaLines.map(colorTty).join("\n");
  whileVisible(tty, async (alive) => {
    while (alive() && !reduced.matches) {
      let out = '<span class="pr">$</span> ';
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
