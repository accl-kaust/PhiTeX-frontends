// /overleaf: the Overleaf extension's own page. Shared chrome, and the
// Overleaf-skinned editable replica (the same engine as the home page).
import "./style.css";
import { initChrome } from "./ui.ts";
import { initReplica } from "./replica.ts";

initChrome();
initReplica();

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
