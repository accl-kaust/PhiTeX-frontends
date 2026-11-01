// /overleaf: the Overleaf extension's own page. Shared chrome, and the
// Overleaf-skinned editable replica (the same engine as the home page).
import "./style.css";
import { initChrome } from "./ui.ts";
import { initReplica } from "./replica.ts";

initChrome();
initReplica();

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
