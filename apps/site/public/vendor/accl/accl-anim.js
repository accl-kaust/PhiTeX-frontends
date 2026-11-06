/*
 * ACCL logo animation. Needs gsap (web/vendor/gsap.min.js) and web/accl-svg.js.
 *
 *   const svg = ACCL.mount(el, { logo: "wordmark" | "mark", theme: "light" | "dark", background: true });
 *   const tl  = ACCL.intro(svg, { style: "launch" | "blueprint" | "glitch" | "wipe" });   // paused GSAP timeline
 *   tl.play();
 *
 * or simply ACCL.play(el, opts), which mounts, builds and plays (and respects prefers-reduced-motion).
 * The same timeline drives the video export (accl-export.js seeks it frame by frame), so every style
 * must be deterministic: no Math.random, no wall-clock time.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  // The stripes' slant: dx/dy, and the unit vector bottom-left -> top-right (mark units; uniform scale keeps it).
  const SLOPE = 66 / 94;
  const SLANT = [66 / Math.hypot(66, 94), -94 / Math.hypot(66, 94)];
  const COLORS = { teal: "#00A8A4", lime: "#D3C72A", yellow: "#F0B225", orange: "#F58F2D" };
  const STYLES = { launch: "Launch", blueprint: "Blueprint", glitch: "Glitch", wipe: "Wipe" };

  let uid = 0;

  const STYLE = `
.accl-svg { display:block; width:100%; height:auto; }
.accl-svg[data-bg="none"] #bg { display:none; }
.accl-svg[data-theme="light"] #bg { fill:#FFFFFF; }
.accl-svg[data-theme="dark"]  #bg { fill:#1D3E72; }
.accl-svg[data-theme="light"] :is(#A, #ccl, #word-accelerated, #word-connected, #word-computing) { fill:#1D3E72; }
.accl-svg[data-theme="dark"]  :is(#A, #ccl, #word-accelerated, #word-connected, #word-computing) { fill:#FFFFFF; }
`;

  function el(tag, attrs, parent, before) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.insertBefore(e, before || null);
    return e;
  }

  // Small seeded PRNG (mulberry32) so "random" effects render identically on every run.
  function rng(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function injectStyle() {
    if (document.getElementById("accl-anim-style")) return;
    const s = document.createElement("style");
    s.id = "accl-anim-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function mount(container, { logo = "wordmark", theme = "light", background = true } = {}) {
    injectStyle();
    container.innerHTML = window.ACCL_SVG[logo];
    const svg = container.querySelector("svg");
    svg.classList.add("accl-svg");
    svg.dataset.theme = theme;
    svg.dataset.bg = background ? "solid" : "none";
    return svg;
  }

  // Shared context: element handles, a <g class="accl-content"> wrapping everything but the background, and the timeline.
  function setup(svg) {
    const u = uid++;
    const id = (n) => `accl${u}-${n}`;
    const $ = (s) => svg.querySelector(s);
    const $$ = (s) => [...svg.querySelectorAll(s)];
    const defs = $("defs") || el("defs", {}, svg, svg.firstChild);
    let content = $(".accl-content");
    if (!content) {
      content = el("g", { class: "accl-content" });
      [...svg.children].forEach((n) => {
        if (n.id !== "bg" && !["title", "desc", "defs", "style"].includes(n.tagName)) content.appendChild(n);
      });
      svg.appendChild(content);
    }
    const A = $("#A");
    const layer = A.parentNode; // mark coordinate space (scaled <g id="mark"> in the wordmark)
    return {
      svg, id, $, $$, defs, content, A, layer,
      ccl: $("#ccl"),
      stripes: ["teal", "lime", "yellow", "orange"].map((c) => $("#stripe-" + c)),
      acc: $$("#word-accelerated .letter"),
      typed: $$("#word-connected .letter, #word-computing .letter"),
      lab: $$("#word-lab .letter"),
      vb: svg.viewBox.baseVal,
      ink: getComputedStyle(A).fill,
      // svg user units per unit of `node`'s coordinate space
      scaleOf: (node) => node.getCTM().a / svg.getCTM().a,
      tl: gsap.timeline({ paused: true, defaults: { ease: "expo.out" } }),
    };
  }

  // ---------- shared pieces ----------

  function glowFilter(c, std = 0.9) {
    const f = el("filter", { id: c.id("glow"), x: "-20%", y: "-20%", width: "140%", height: "140%" }, c.defs);
    el("feGaussianBlur", { stdDeviation: std, result: "b" }, f);
    const merge = el("feMerge", {}, f);
    ["b", "b", "SourceGraphic"].forEach((i) => el("feMergeNode", { in: i }, merge));
    return `url(#${c.id("glow")})`;
  }

  // A soft white band sweeping across the mark, parallel to the stripes.
  function sheen(c, at) {
    const clip = el("clipPath", { id: c.id("sheen") }, c.defs);
    [...c.stripes, c.A, c.ccl].forEach((p) => el("path", { d: p.getAttribute("d"), "clip-rule": p.getAttribute("fill-rule") || "nonzero" }, clip));
    const soft = el("filter", { id: c.id("soft"), x: "-50%", y: "-10%", width: "200%", height: "120%" }, c.defs);
    el("feGaussianBlur", { stdDeviation: "2.5" }, soft);
    const g = el("g", { "clip-path": `url(#${c.id("sheen")})` }, c.layer);
    const band = el("polygon", { points: "0,112 12,112 96.3,-8 84.3,-8", fill: "#FFFFFF", opacity: 0.55, filter: `url(#${c.id("soft")})` }, g);
    c.tl.fromTo(band, { x: -110 }, { x: 120, duration: 0.9, ease: "power2.inOut" }, at);
  }

  function labPop(c, at) {
    if (!c.lab.length) return;
    gsap.set(c.lab, { opacity: 0, scale: 0.2, y: 60, transformOrigin: "50% 100%" });
    c.tl.to(c.lab, { opacity: 1, scale: 1, y: 0, duration: 0.55, ease: "back.out(2.6)", stagger: 0.07 }, at);
  }

  // ---------- style 1: launch ----------
  // Stripes shoot in, the A draws itself, ccl lights up like a circuit, letters launch out of the A,
  // the tagline types on and LAB pops.
  function launch(c) {
    const { tl, $, A, ccl, layer, ink } = c;
    const glow = glowFilter(c);

    // Stripes shoot in along their slant, with ghost trails and a small overshoot: from below left, or (from: "top",
    // phitex.org, where a ribbon runs down into them) from above right.
    const D = 150, k = c.opts.from === "top" ? 1 : -1;
    const from = { x: k * SLANT[0] * D, y: k * SLANT[1] * D };
    c.stripes.forEach((s, i) => {
      const t0 = 0.05 + i * 0.07;
      [0.4, 0.22, 0.1].forEach((op, k) => {
        const trail = s.cloneNode();
        trail.removeAttribute("id");
        trail.setAttribute("opacity", op);
        s.parentNode.insertBefore(trail, s);
        tl.fromTo(trail, from, { x: 0, y: 0, duration: 0.9 }, t0 + (k + 1) * 0.04)
          .to(trail, { opacity: 0, duration: 0.3, ease: "none" }, t0 + 0.35 + (k + 1) * 0.04);
      });
      tl.fromTo(s, from, { x: 0, y: 0, duration: 0.95, ease: "back.out(1.15)" }, t0);
    });

    // The A draws its outline, then fills.
    const aLine = el("path", { d: A.getAttribute("d"), fill: "none", stroke: ink, "stroke-width": 1.1, "stroke-linejoin": "round" }, layer, A.nextSibling);
    const aLen = aLine.getTotalLength();
    gsap.set(aLine, { attr: { "stroke-dasharray": aLen, "stroke-dashoffset": aLen } });
    gsap.set(A, { opacity: 0 });
    tl.to(aLine, { attr: { "stroke-dashoffset": 0 }, duration: 0.75, ease: "power2.inOut" }, 0.3)
      .to(A, { opacity: 1, duration: 0.35, ease: "power1.out" }, 0.85)
      .to(aLine, { opacity: 0, duration: 0.3, ease: "none" }, 1.05);

    // "ccl" lights up like a circuit: teal traces draw, it fills, then signal pulses run the traces.
    const parts = ccl.getAttribute("d").split(/(?=M)/);
    gsap.set(ccl, { opacity: 0 });
    const traces = parts.map((d) => {
      const p = el("path", { d, fill: "none", stroke: COLORS.teal, "stroke-width": 0.9, "stroke-linejoin": "round", filter: glow }, layer);
      const len = p.getTotalLength();
      gsap.set(p, { attr: { "stroke-dasharray": len, "stroke-dashoffset": len } });
      tl.to(p, { attr: { "stroke-dashoffset": 0 }, duration: 0.8, ease: "power2.inOut" }, 0.5)
        .to(p, { opacity: 0, duration: 0.4, ease: "none" }, 1.35);
      return { d, len };
    });
    tl.to(ccl, { opacity: 1, duration: 0.4, ease: "power1.out" }, 1.1);
    traces.forEach(({ d, len }, i) => {
      const pulse = el("path", { d, fill: "none", stroke: i ? COLORS.lime : COLORS.teal, "stroke-width": 1.2, "stroke-linecap": "round", filter: glow, opacity: 0 }, layer);
      const dash = len * 0.12;
      gsap.set(pulse, { attr: { "stroke-dasharray": `${dash} ${len}`, "stroke-dashoffset": dash } });
      tl.set(pulse, { opacity: 1 }, 1.25)
        .to(pulse, { attr: { "stroke-dashoffset": -len }, duration: 0.9, ease: "power2.inOut" }, 1.25)
        .set(pulse, { opacity: 0 }, 2.15);
    });

    // "CCELERATED" is launched out of the A, each letter with a horizontal motion streak.
    if (c.acc.length) {
      const m = $("#mark").transform.baseVal.consolidate().matrix;
      const ab = A.getBBox();
      const edge = m.a * (ab.x + ab.width) + m.e; // right edge of the A in wordmark space
      const clip = el("clipPath", { id: c.id("launch") }, c.defs);
      el("rect", { x: edge, y: 0, width: 10000, height: 2000 }, clip);
      $("#word-accelerated").setAttribute("clip-path", `url(#${c.id("launch")})`);
      const n = c.acc.length;
      c.acc.forEach((l, i) => {
        const b = l.getBBox();
        const f = el("filter", { id: c.id("mb" + i), x: "-2", y: "0", width: "5", height: "1" }, c.defs);
        const blur = el("feGaussianBlur", { stdDeviation: "0 0" }, f);
        l.setAttribute("filter", `url(#${c.id("mb" + i)})`);
        const at = 0.8 + (n - 1 - i) * 0.045;
        tl.fromTo(l, { x: edge - (b.x + b.width) - 360 }, { x: 0, duration: 1.1 }, at)
          .fromTo(blur, { attr: { stdDeviation: "90 0" } }, { attr: { stdDeviation: "0 0" }, duration: 0.8 }, at)
          .set(l, { attr: { filter: "none" } }, at + 0.8);
      });
      tl.set($("#word-accelerated"), { attr: { "clip-path": "none" } }, 0.8 + n * 0.045 + 1.1);
    }

    // "CONNECTED COMPUTING" types on behind a teal caret; "LAB" pops in orange.
    if (c.typed.length) {
      const boxes = c.typed.map((l) => l.getBBox());
      const top = Math.min(...boxes.map((b) => b.y)), bottom = Math.max(...boxes.map((b) => b.y + b.height));
      const caret = el("rect", { x: boxes[0].x - 30, y: top - 10, width: 16, height: bottom - top + 20, fill: COLORS.teal, opacity: 0 }, $("#tagline"));
      gsap.set(c.typed, { opacity: 0 });
      const t0 = 1.6, step = 0.032;
      tl.set(caret, { opacity: 1 }, t0 - 0.12);
      c.typed.forEach((l, i) => {
        tl.set(l, { opacity: 1 }, t0 + i * step).set(caret, { attr: { x: boxes[i].x + boxes[i].width + 14 } }, t0 + i * step);
      });
      const tEnd = t0 + c.typed.length * step;
      if (c.lab.length) {
        tl.to(caret, { attr: { x: c.lab[0].getBBox().x - 30 }, duration: 0.12, ease: "power2.out" }, tEnd)
          .to(caret, { opacity: 0, duration: 0.1, ease: "none" }, tEnd + 0.14);
        labPop(c, tEnd + 0.12);
      } else {
        tl.to(caret, { opacity: 0, duration: 0.1, ease: "none" }, tEnd + 0.2);
      }
    }

    sheen(c, 2.75);
  }

  // ---------- style 2: blueprint ----------
  // A technical grid fades in, every shape is drafted as a teal outline, then a scan beam sweeps
  // left to right and fills each shape as it passes.
  function blueprint(c) {
    const { tl, vb, svg, content } = c;
    const H = vb.height, cell = H / 14;
    const pat = el("pattern", { id: c.id("grid"), width: cell, height: cell, patternUnits: "userSpaceOnUse", x: vb.x, y: vb.y }, c.defs);
    el("path", { d: `M ${cell} 0 L 0 0 0 ${cell}`, fill: "none", stroke: COLORS.teal, "stroke-width": cell * 0.03, opacity: 0.45 }, pat);
    const grid = el("rect", { x: vb.x, y: vb.y, width: vb.width, height: H, fill: `url(#${c.id("grid")})`, opacity: 0 }, svg, content);
    tl.to(grid, { opacity: 1, duration: 0.5, ease: "power1.out" }, 0);

    const shapes = [...c.stripes, c.A, c.ccl, ...c.acc, ...c.typed, ...c.lab];
    const sw = H / 260; // outline width in svg units
    gsap.set(shapes, { fillOpacity: 0 });
    const items = shapes.map((s) => {
      const line = el("path", { d: s.getAttribute("d"), fill: "none", stroke: COLORS.teal, "stroke-width": sw / c.scaleOf(s.parentNode), "stroke-linejoin": "round" }, s.parentNode, s.nextSibling);
      const len = line.getTotalLength();
      gsap.set(line, { attr: { "stroke-dasharray": len, "stroke-dashoffset": len } });
      return { s, line, x: s.getBoundingClientRect().left };
    });
    const draft = 1.0 / items.length;
    items.forEach(({ line }, i) => tl.to(line, { attr: { "stroke-dashoffset": 0 }, duration: 0.7, ease: "power2.inOut" }, 0.2 + i * draft));

    // Scan beam: fills follow its position.
    const fillAt = 1.45, sweep = 0.8;
    const bw = vb.width * 0.004;
    const beam = el("g", { opacity: 0 }, svg);
    el("rect", { x: -bw * 6, y: vb.y, width: bw * 12, height: H, fill: COLORS.teal, opacity: 0.12 }, beam);
    el("rect", { x: -bw * 2.5, y: vb.y, width: bw * 5, height: H, fill: COLORS.teal, opacity: 0.25 }, beam);
    el("rect", { x: -bw / 2, y: vb.y, width: bw, height: H, fill: COLORS.teal }, beam);
    tl.set(beam, { opacity: 1 }, fillAt)
      .fromTo(beam, { x: vb.x }, { x: vb.x + vb.width, duration: sweep, ease: "none" }, fillAt)
      .set(beam, { opacity: 0 }, fillAt + sweep);
    const x0 = svg.getBoundingClientRect().left, w = svg.getBoundingClientRect().width;
    items.forEach(({ s, line, x }) => {
      const t = fillAt + sweep * Math.max(0, Math.min(1, (x - x0) / w));
      tl.to(s, { fillOpacity: 1, duration: 0.2, ease: "power1.out" }, t).to(line, { opacity: 0, duration: 0.45, ease: "none" }, t + 0.1);
    });
    tl.to(grid, { opacity: 0, duration: 0.6, ease: "power1.inOut" }, fillAt + sweep + 0.1);
    sheen(c, fillAt + sweep + 0.35);
  }

  // ---------- style 3: glitch ----------
  // The logo flickers in as displaced horizontal slices with teal/orange colour-split ghosts,
  // snaps clean, then a short after-glitch.
  function glitch(c) {
    const { tl, vb, svg, content } = c;
    const rand = rng(20251016);
    const paths = [...content.querySelectorAll("path")];
    const fills = paths.map((p) => getComputedStyle(p).fill);
    const copy = (tint) => {
      const g = content.cloneNode(true);
      g.removeAttribute("class");
      [...g.querySelectorAll("path")].forEach((p, i) => (p.style.fill = tint || fills[i]));
      g.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      return g;
    };
    const split = [COLORS.teal, COLORS.orange].map((tint) => {
      const g = copy(tint);
      g.setAttribute("opacity", 0);
      svg.insertBefore(g, content);
      return g;
    });
    const BANDS = 7;
    const bands = [];
    for (let i = 0; i < BANDS; i++) {
      const cp = el("clipPath", { id: c.id("band" + i) }, c.defs);
      el("rect", { x: vb.x - vb.width, y: vb.y + (vb.height * i) / BANDS, width: vb.width * 3, height: vb.height / BANDS + 0.5 }, cp);
      const wrap = el("g", { "clip-path": `url(#${c.id("band" + i)})`, opacity: 0 }, svg);
      const g = copy();
      wrap.appendChild(g);
      bands.push({ wrap, g });
    }
    gsap.set(content, { opacity: 0 });

    const burst = (t0, t1, strength, settle) => {
      for (let t = t0; t < t1; t += 1 / 30) {
        const k = (t - t0) / (t1 - t0);
        const amp = strength * (settle ? (1 - k) ** 1.5 : 1) * vb.width;
        const on = rand() < (settle ? 0.35 + 0.6 * k : 0.9);
        bands.forEach(({ wrap, g }) => {
          const hit = rand() < (settle ? 0.55 * (1 - k) + 0.1 : 0.35);
          tl.set(wrap, { opacity: on ? 1 : 0 }, t).set(g, { x: hit ? (rand() - 0.5) * 2 * amp : 0 }, t);
        });
        split.forEach((g, j) => tl.set(g, { opacity: on ? 0.85 : 0, x: (j ? 1 : -1) * (amp * 0.2 + vb.width * 0.004) * (0.5 + rand()) }, t));
      }
      tl.set([...bands.map((b) => b.wrap), ...split], { opacity: 0 }, t1);
    };

    burst(0.15, 1.55, 0.08, true);
    tl.set(content, { opacity: 1 }, 1.55)
      .fromTo(content, { scale: 1.035, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.6, ease: "expo.out", immediateRender: false }, 1.55);
    tl.set(content, { opacity: 0 }, 2.35);
    burst(2.35, 2.5, 0.02, false);
    tl.set(content, { opacity: 1 }, 2.5);
    sheen(c, 2.6);
  }

  // ---------- style 4: wipe ----------
  // Four slanted bars in the stripe colours sweep across the frame and reveal the logo behind the last one.
  function wipe(c) {
    const { tl, vb, svg, content } = c;
    const top = vb.y, bot = vb.y + vb.height, rise = SLOPE * vb.height;
    const w = Math.max(vb.width * 0.08, vb.height * 0.35), gap = w * 1.08;
    const group = el("g", {}, svg);
    ["teal", "lime", "yellow", "orange"].forEach((name, i) =>
      el("polygon", { points: `${-i * gap},${bot} ${w - i * gap},${bot} ${w - i * gap + rise},${top} ${-i * gap + rise},${top}`, fill: COLORS[name] }, group)
    );
    // Reveal everything left of the middle of the trailing (orange) bar.
    const edge = -3 * gap + w * 0.5, far = vb.x - vb.width * 10;
    const cp = el("clipPath", { id: c.id("wipe") }, c.defs);
    const poly = el("polygon", { points: `${far},${bot} ${edge},${bot} ${edge + rise},${top} ${far},${top}` }, cp);
    content.setAttribute("clip-path", `url(#${c.id("wipe")})`);
    const inner = el("g", {}, content); // slides inside the fixed clip
    [...content.childNodes].forEach((n) => n !== inner && inner.appendChild(n));

    const start = vb.x - w - rise, end = vb.x + vb.width + 3 * gap + w;
    tl.fromTo([group, poly], { x: start }, { x: end, duration: 1.35, ease: "power3.inOut" }, 0.1)
      .set(content, { attr: { "clip-path": "none" } }, 1.45)
      .fromTo(inner, { x: -vb.width * 0.025 }, { x: 0, duration: 1.4, ease: "expo.out" }, 0.35);
    labPop(c, 1.35);
    sheen(c, 1.85);
  }

  const BUILDERS = { launch, blueprint, glitch, wipe };

  function intro(svg, opts = {}) {
    const { style = "launch" } = opts;
    const c = setup(svg);
    c.opts = opts;
    (BUILDERS[style] || launch)(c);
    return c.tl;
  }

  function play(container, opts = {}) {
    const svg = mount(container, opts);
    const tl = intro(svg, opts);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) tl.progress(1);
    else tl.play();
    return tl;
  }

  window.ACCL = { mount, intro, play, STYLE, STYLES };
})();
