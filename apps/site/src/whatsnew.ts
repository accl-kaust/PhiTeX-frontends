// The Overleaf page's "New in 1.0": a carousel, a slide a feature. The slides
// sit side by side in a track that scrolls and snaps (a swipe moves it
// natively); the tabs, the arrows and the arrow keys scroll it, and the slide
// in view is the one marked on (its picture's animations run only then, from
// their start). The slides never advance by themselves (the looks on the
// loading animations slide do: a tour, initLooks).
//
// The loading animations' slide plays the real ones: the extension's viewer's
// openings (phitex/viewer/src/openings, the frontends' PhiTeX submodule), with
// the same preview() its Settings › Appearance gallery plays. Loaded on their
// own (a chunk of their own, the openings and their helpers, none of the rest
// of the viewer) when the section comes near.
import { reduced } from "./ui.ts";

type Openings = typeof import("../../../phitex/viewer/src/openings/index.ts");

export function initWhatsNew() {
  const root = document.querySelector<HTMLElement>(".nw");
  if (!root) return;
  const track = root.querySelector<HTMLElement>(".nw-track")!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const slides = [...track.querySelectorAll<HTMLElement>(".nw-slide")];
  const [prev, next] = [...root.querySelectorAll<HTMLButtonElement>(".nw-arrow")];
  const strip = root.querySelector<HTMLElement>(".nw-tabs")!;
  let cur = 0, ready = false;
  /** Where the track is scrolled to with slide `i` centred in it. */
  const at = (i: number) => slides[i].offsetLeft - (track.clientWidth - slides[i].offsetWidth) / 2;

  /** Slide `i` marked as the one in view: its tab selected, the others out of reach. */
  const mark = (i: number) => {
    if (i === cur && ready) return;
    cur = i;
    ready = true;
    slides.forEach((s, k) => {
      s.classList.toggle("on", k === i);
      s.inert = k !== i;
    });
    tabs.forEach((t, k) => {
      t.setAttribute("aria-selected", String(k === i));
      t.tabIndex = k === i ? 0 : -1;
    });
    prev.disabled = i === 0;
    next.disabled = i === slides.length - 1;
    // (the tab into view in its own strip, when the strip scrolls: never the page)
    const t = tabs[i], over = t.offsetLeft + t.offsetWidth - (strip.scrollLeft + strip.clientWidth), under = t.offsetLeft - strip.scrollLeft;
    if (over > 0) strip.scrollBy({ left: over + 8, behavior: reduced.matches ? "auto" : "smooth" });
    else if (under < 0) strip.scrollBy({ left: under - 8, behavior: reduced.matches ? "auto" : "smooth" });
    onShow(slides[i].id);
  };
  /** Slide `i` scrolled into view (sliding, unless motion is reduced). */
  const go = (i: number) => {
    i = Math.max(0, Math.min(slides.length - 1, i));
    track.scrollTo({ left: at(i), behavior: reduced.matches ? "auto" : "smooth" });
    mark(i);
  };
  // (the slide in view after a scroll, a swipe's or ours: whichever is nearest)
  let settle = 0;
  const seen = () => {
    const mid = track.scrollLeft + track.clientWidth / 2;
    let i = 0;
    slides.forEach((s, k) => Math.abs(s.offsetLeft + s.offsetWidth / 2 - mid) < Math.abs(slides[i].offsetLeft + slides[i].offsetWidth / 2 - mid) && (i = k));
    if (i !== cur) mark(i);
  };
  track.addEventListener("scroll", () => {
    clearTimeout(settle);
    settle = window.setTimeout(seen, 120);
  }, { passive: true });
  tabs.forEach((t, k) => t.addEventListener("click", () => go(k)));
  prev.addEventListener("click", () => go(cur - 1));
  next.addEventListener("click", () => go(cur + 1));
  // (← and → anywhere in the carousel but the picker of looks, which has its own; Home and End on the tabs)
  root.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[role="radiogroup"]') || e.altKey || e.ctrlKey || e.metaKey) return;
    const onTab = t.getAttribute("role") === "tab";
    // (from the tab with the focus, on the tabs; from the slide in view, elsewhere)
    const from = onTab ? tabs.indexOf(t as HTMLButtonElement) : cur;
    let i = -1;
    if (e.key === "ArrowLeft") i = from - 1;
    else if (e.key === "ArrowRight") i = from + 1;
    else if (onTab && e.key === "Home") i = 0;
    else if (onTab && e.key === "End") i = slides.length - 1;
    if (i < 0 || i >= slides.length) return;
    e.preventDefault();
    go(i);
    if (onTab) tabs[i].focus();
  });
  // (a resize keeps the slide in view where it is)
  // (the page's width without its scrollbar, the track's: a resize keeps the slide in view where it is)
  const fit = () => {
    root.style.setProperty("--vw", `${document.documentElement.clientWidth}px`);
    track.scrollTo({ left: at(cur) });
  };
  new ResizeObserver(fit).observe(document.documentElement);
  fit();
  // (a neighbour peeking at a side, inert, so its clicks land on the track: the one under the pointer is gone to)
  track.addEventListener("click", (e) => {
    const k = slides.findIndex((s) => {
      const r = s.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (k >= 0 && k !== cur) go(k);
  });
  const looks = initLooks(root);
  function onShow(id: string) {
    looks?.shown(id === "nw-load");
  }
  mark(0);
}

/** The loading animations' slide: a tile playing the look picked, and the picker. */
function initLooks(root: HTMLElement) {
  const tile = root.querySelector<HTMLElement>(".nw-tile");
  const picker = root.querySelector<HTMLElement>(".nw-looks");
  const playBtn = root.querySelector<HTMLButtonElement>(".nw-play");
  if (!tile || !picker || !playBtn) return null;
  let mod: Openings | null = null, hint = "", loading: Promise<void> | null = null;
  let picked = "phitex", slideOn = false, onScreen = false, stop: (() => void) | null = null, once = 0;
  // (the tour: every few seconds the next look, in the viewer's order, Bad Apple left out as the default leaves it out;
  // held while the pointer or the focus is on the slide's picture, ended by a look picked, and none under reduced motion)
  const TOUR_MS = 3200;
  let touring = true, held = false, tour = 0;
  const STEPS = ["Reading the project", "Fetching packages", "Typesetting"] as const; // (the viewer's own words, panel.ts)
  const dark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };

  const halt = () => {
    stop?.();
    stop = null;
    clearTimeout(once);
    clearTimeout(tour);
  };
  const onward = () => {
    clearTimeout(tour);
    if (!touring || held || reduced.matches || !stop) return;
    tour = window.setTimeout(() => {
      const ids = mod!.LOOKS.map((l) => l.id).filter((id) => id !== "badapple");
      picked = ids[(ids.indexOf(picked) + 1) % ids.length];
      check();
      play();
    }, TOUR_MS);
  };
  /** The look picked, played over and over (its gallery's preview); under reduced motion only when asked, one round, then still. */
  const play = (asked = false) => {
    halt();
    if (!mod || !slideOn || !onScreen) return;
    if (reduced.matches && !asked) return void (tile.replaceChildren(playBtn), (playBtn.hidden = false));
    playBtn.hidden = true;
    stop = mod.preview(picked, tile, dark(), "main.tex", STEPS, hint);
    onward();
    if (reduced.matches) once = window.setTimeout(() => (halt(), tile.replaceChildren(playBtn), (playBtn.hidden = false)), 7600);
  };
  const load = () =>
    (loading ??= Promise.all([import("../../../phitex/viewer/src/openings/index.ts"), import("../../../phitex/viewer/src/hints.ts")]).then(([m, h]) => {
      mod = m;
      hint = h.hintsFor("overleaf")[0] ?? "";
      // (every look, in the viewer's order: Bad Apple, the one the default leaves out, is its last)
      picker.replaceChildren(
        ...m.LOOKS.map((l) => {
          const b = document.createElement("button");
          b.type = "button";
          b.setAttribute("role", "radio");
          b.dataset.id = l.id;
          b.textContent = l.name;
          return b;
        }),
      );
      check();
      play();
    }));
  const radios = () => [...picker.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const check = () =>
    radios().forEach((b) => {
      const on = b.dataset.id === picked;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  const pick = (id: string, focus = false) => {
    touring = false;
    picked = id;
    check();
    if (focus) radios().find((b) => b.dataset.id === id)?.focus();
    play(true);
  };
  picker.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="radio"]');
    if (b) pick(b.dataset.id!);
  });
  // (a radio group's keys: the arrows move the choice, and play it)
  picker.addEventListener("keydown", (e) => {
    const all = radios(), k = all.findIndex((b) => b.dataset.id === picked);
    const to = { ArrowDown: k + 1, ArrowRight: k + 1, ArrowUp: k - 1, ArrowLeft: k - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to === undefined || !all.length) return;
    e.preventDefault();
    pick(all[(to + all.length) % all.length].dataset.id!, true);
  });
  playBtn.addEventListener("click", () => play(true));
  const fig = tile.parentElement!;
  const hold = (on: boolean) => {
    held = on;
    on ? clearTimeout(tour) : onward();
  };
  fig.addEventListener("pointerenter", () => hold(true));
  fig.addEventListener("pointerleave", () => hold(fig.contains(document.activeElement)));
  fig.addEventListener("focusin", () => hold(true));
  fig.addEventListener("focusout", (e) => !fig.contains(e.relatedTarget as Node) && hold(fig.matches(":hover")));

  // (fetched when the section comes near; played only while its slide is the one in view and on screen)
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting) void load();
  }, { rootMargin: "800px 0px" }).observe(root);
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    onScreen ? play() : halt();
  }, { threshold: 0.2 }).observe(tile);
  // (the page's theme changed: the sheet dark or light with it)
  const again = () => stop && play();
  new MutationObserver(again).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", again);
  reduced.addEventListener("change", () => play());

  return {
    shown(on: boolean) {
      if (on === slideOn) return;
      slideOn = on;
      on ? play() : halt();
    },
  };
}
