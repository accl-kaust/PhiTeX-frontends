// /overleaf: the Overleaf extension's own page. Shared chrome, and the
// Overleaf-skinned editable replica (the same engine as the home page).
import "./style.css";
import { initChrome } from "./ui.ts";
import { initReplica } from "./replica.ts";
import { initWhatsNew } from "./whatsnew.ts";

initChrome();
initReplica();
initWhatsNew();

// The comparison and the collaborators' page grow as their words are typed in: each is held at its tallest (every
// word in, as it is with no animation), so the page around it never moves. Measured again when its width changes.
for (const page of document.querySelectorAll<HTMLElement>(".fd-cmp .fd-page, .fd-col .fd-page")) {
  const fit = () => {
    const ghost = page.cloneNode(true) as HTMLElement;
    ghost.style.cssText = `position: absolute; visibility: hidden; width: ${page.offsetWidth}px; min-height: 0`;
    for (const e of ghost.querySelectorAll<HTMLElement>("*")) e.style.animation = "none";
    page.after(ghost);
    page.style.minHeight = `${ghost.offsetHeight}px`;
    ghost.remove();
  };
  let w = 0;
  new ResizeObserver(() => { if (page.offsetWidth !== w) { w = page.offsetWidth; fit(); } }).observe(page);
  document.fonts.ready.then(fit);
}

// Colour lines: the page's words dealt into the lines they fall on, each word given its line's
// gradient (sized to the line, shifted to the word) so the line reads as one fade: ink → colour on
// one line, colour → ink on the next, the colour changing every two lines (blue, red), as the
// viewer's own Colour lines does. Dealt again when the width changes; the switch turns it off.
const INK = "#111", WASP = ["#1f3fe0", "#d42020"];
for (const fig of document.querySelectorAll<HTMLElement>(".fd-wasp")) {
  const page = fig.querySelector<HTMLElement>(".fd-page")!;
  const body = page.querySelector<HTMLElement>("p:not(.fd-h)")!;
  body.innerHTML = body.textContent!.trim().split(/\s+/).map((w) => `<span class="wl">${w}</span>`).join(" ");
  const words = [...body.querySelectorAll<HTMLElement>(".wl")];
  const deal = () => {
    const lines: HTMLElement[][] = [];
    let top = NaN;
    for (const w of words) {
      if (w.offsetTop !== top) lines.push([]), (top = w.offsetTop);
      lines[lines.length - 1].push(w);
    }
    lines.forEach((line, i) => {
      const c = WASP[Math.floor(i / 2) % 2], g = i % 2 ? `${c}, ${INK}` : `${INK}, ${c}`;
      const x0 = line[0].offsetLeft, last = line[line.length - 1], width = last.offsetLeft + last.offsetWidth - x0;
      for (const w of line) {
        w.style.backgroundImage = `linear-gradient(90deg, ${g})`;
        w.style.backgroundSize = `${width}px 100%`;
        w.style.backgroundPosition = `${x0 - w.offsetLeft}px 0`;
      }
    });
  };
  let w = 0;
  new ResizeObserver(() => { if (body.offsetWidth !== w) { w = body.offsetWidth; deal(); } }).observe(body);
  document.fonts.ready.then(deal);
  const sw = fig.querySelector<HTMLButtonElement>(".fd-switch")!;
  sw.addEventListener("click", () => {
    const on = sw.getAttribute("aria-pressed") !== "true";
    sw.setAttribute("aria-pressed", String(on));
    page.classList.toggle("on", on);
  });
}

// Click-to-load the Overleaf demo video (no YouTube request until play).
const v = document.querySelector<HTMLElement>(".video[data-yt]");
v?.querySelector(".video-play")?.addEventListener("click", () => {
  const f = document.createElement("iframe");
  f.src = `https://www.youtube-nocookie.com/embed/${v.dataset.yt}?autoplay=1&rel=0`;
  f.title = "PhiTeX for Overleaf demo";
  f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  f.allowFullscreen = true;
  v.replaceChildren(f);
});
