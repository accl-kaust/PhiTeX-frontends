import "./style.css";
import { $, $$, esc, initChrome, reduced, sleep, whileVisible } from "./ui.ts";
import { initReplica } from "./replica.ts";
import { typeset } from "./fake.ts";
import phiSsa from "./content/phi.ssa?raw";

initChrome();
initReplica();

// ── diagnostics: fill the vim window with ~ empty-line markers ──
$("#vim-pre")?.insertAdjacentHTML("beforeend", "\n" + Array.from({ length: 9 }, () => '<span class="tw">~</span>').join("\n"));

// ── hero: the modern CLI, animated (DESIGN MOCK) ──
// A `phitex watch` session: a cold build, then edits rebuilt incrementally.
// The TUI (status line, progress bar, sparkline of the last builds' times)
// is the real one; the per-edit times are illustrative, within the measured
// native range (a word edit in a 64-page thesis ≈ 10 ms; cold ≈ 2× pdflatex).
{
  const out = $("#cli");
  if (out) {
    const c = (cls: string, t: string) => `<span class="${cls}">${esc(t)}</span>`;
    const cmd = "phitex watch thesis.tex";
    const preview = c("c", "→ live preview  ") + c("v", "http://127.0.0.1:7881/9f2e…/");
    const status = c("c", "── watching thesis.tex → thesis.pdf · ") + c("b", "?") + c("c", " help");
    // [what changed, what rebuilt, ms]
    const edits: [string, string, number][] = [
      ["§ Results", "1 chunk · 1 page", 9],
      ["\\def\\kw{…}", "3 chunks · 2 pages", 14],
      ["\\label{fig:phi}", ".aux → .bbl · 4 chunks", 23],
      ["a new paragraph", "1 chunk · 1 page", 7],
      ["\\cite{knuth84}", "2 chunks · 1 page", 11],
    ];
    const sparks = "▁▂▃▅▂▄▃▆";
    const W = 22;
    const staticRender = () => {
      const lines = [c("pt", "$") + " " + cmd, "  " + c("h", "✓ built") + "  thesis.pdf · " + c("c", "12 pp · 418 ms"), preview, status];
      edits.forEach(([lbl, det, ms], i) =>
        lines.push(c("pt", "~") + " edit " + c("cs", lbl) + "   rebuilt " + c("c", det) + " · " + c("h", ms + " ms") + "   " + c("v", sparks.slice(0, i + 1))),
      );
      out.innerHTML = lines.join("\n");
    };

    whileVisible(out, async (alive) => {
      while (alive()) {
        if (reduced.matches) return staticRender();
        const buf: string[] = [""];
        const paint = () => (out.innerHTML = buf.join("\n"));

        // type the command
        let typed = c("pt", "$") + " ";
        for (const ch of cmd) {
          if (!alive()) return;
          typed += esc(ch);
          buf[0] = typed + c("cur", "▌");
          paint();
          await sleep(42 + Math.random() * 55);
        }
        buf[0] = typed;
        paint();
        await sleep(360);

        // the cold build: a filling bar
        for (let p = 0; p <= W; p++) {
          if (!alive()) return;
          const bar = "━".repeat(p) + (p < W ? "╸" : "") + "─".repeat(Math.max(0, W - p - 1));
          const pct = Math.round((p / W) * 100);
          buf[1] = "  " + c("h", "Pass 1") + "  " + c("v", bar) + "  " + c("c", `cold build · ${pct}%`);
          paint();
          await sleep(15 + Math.random() * 14);
        }
        buf[1] = "  " + c("h", "✓ built") + "  thesis.pdf · " + c("c", "12 pp · 418 ms");
        buf[2] = preview;
        buf[3] = status;
        paint();
        await sleep(850);

        // edits, rebuilt one at a time; the sparkline grows
        for (let i = 0; i < edits.length; i++) {
          if (!alive()) return;
          const [lbl, det, ms] = edits[i];
          buf.push(c("pt", "~") + " edit " + c("cs", lbl) + "   rebuilt " + c("c", det) + " · " + c("h", ms + " ms") + "   " + c("v", sparks.slice(0, i + 1)));
          paint();
          await sleep(950 + Math.random() * 500);
        }
        await sleep(2200);
      }
    });
  }
}

// ── how it works: the document-flow (the same doc, through each form) ──
const flowCard = $("#flow-card");
if (flowCard) {
  // One tiny document, shown in each representation. The middle paragraph
  // stays lit across all five, to show what a single edit threads through.
  const REPS = [
    `<div class="rep-h">files · you change one line</div>
<pre class="rep-pre"><span class="cs">\\section</span>{Results}
<span class="chunk hot">We find that <span class="ma">$\\varphi = 1.618$</span>.<span class="etag">edited</span></span>
Proof follows from <span class="cs">\\cite</span>{knuth}.</pre>`,
    `<div class="rep-h">CST · only the touched node reparses</div>
<ul class="tree"><li class="kept">¶ section “Results”</li><li class="hot">¶ “We find that φ = 1.618.”</li><li class="kept">¶ “Proof follows from …”</li></ul>`,
    `<div class="rep-h">SSA · only the changed chunk re-runs</div>
<div class="ssa-chunks"><div class="chunk kept"><span class="c">; chunk 1 · kept</span>
%1 = <span class="p">section</span>("Results")</div><div class="chunk hot"><span class="c">; chunk 2 · re-run</span>
%2 = <span class="p">text</span>("We find …")
%3 = <span class="p">math</span>(φ = 1.618)</div><div class="chunk kept"><span class="c">; chunk 3 · kept</span>
%4 = <span class="p">cite</span>(knuth)</div></div>`,
    `<div class="rep-h">pages · only the affected page rebuilds</div>
<div class="pagerow"><div class="pg built"><b>p.4</b><span class="pl"></span><span class="pl hot"></span><span class="pl sh"></span></div><div class="pg kept"><b>p.5</b><span class="pl"></span><span class="pl"></span><span class="pl sh"></span><span class="ptag">reused</span></div></div>`,
    `<div class="rep-h">thesis.pdf</div>
<div class="pagerow"><div class="pg built"><b>p.4</b><span class="pl"></span><span class="pl hot"></span><span class="pl sh"></span></div><div class="pg kept"><b>p.5</b><span class="pl"></span><span class="pl"></span><span class="pl sh"></span><span class="ptag">cached</span></div></div>
<p class="pdf-note">byte-identical to pdfTeX · only p.4's stream is rewritten, p.5 reused</p>`,
  ];
  const rail = $$("#flow-rail li");
  let cur = -1;
  const step = (k: number) => {
    $$(".step").forEach((s) => s.classList.toggle("on", Number(s.dataset.step) === k));
    rail.forEach((li, i) => {
      li.classList.toggle("on", i <= k);
      li.classList.toggle("done", i < k);
      li.classList.toggle("cur", i === k);
    });
    if (k === cur) return;
    cur = k;
    if (reduced.matches) {
      flowCard.innerHTML = REPS[k];
      return;
    }
    flowCard.classList.add("out");
    setTimeout(() => {
      flowCard.innerHTML = REPS[k];
      flowCard.classList.remove("out");
    }, 160);
  };
  const stepIO = new IntersectionObserver(
    (es) => es.forEach((e) => e.isIntersecting && step(Number((e.target as HTMLElement).dataset.step))),
    { rootMargin: "-45% 0px -45% 0px" },
  );
  $$(".step").forEach((s) => stepIO.observe(s));
  step(0);
}

// ── one keystroke: the chunk grid (an illustration of the rule) ──
const grid = $("#ks-grid");
if (grid) {
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
}

// ── tiers ──
if ($(".tier-grid")) {
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
}

// ── everywhere: Overleaf, VS Code and the CLI, side by side, each running ──
if ($("#everywhere")) {
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
