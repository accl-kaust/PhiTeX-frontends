// Shared chrome and helpers for every page (home and /overleaf).
import { EXT, REPO, STORES } from "./links.ts";

export const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
export const reduced = matchMedia("(prefers-reduced-motion: reduce)");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Runs `f` while `el` is on screen (for the looping animations). */
export function whileVisible(el: Element, f: (alive: () => boolean) => Promise<void>) {
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

/** Theme toggle, sticky-nav border, scroll-reveal, and repo links. */
export function initChrome() {
  const theme = $("#theme");
  theme?.addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("theme", root.dataset.theme);
    } catch {}
  });

  const nav = $("#nav");
  if (nav) addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 20), { passive: true });

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

  // Links to the compiler repo, the extension, and the per-browser stores.
  $$<HTMLAnchorElement>("a[data-repo]").forEach((a) => (a.href = REPO));
  $$<HTMLAnchorElement>("a[data-ext]").forEach((a) => (a.href = EXT));
  $$<HTMLAnchorElement>("a[data-store]").forEach((a) => {
    const u = STORES[a.dataset.store!];
    if (u) a.href = u;
  });
}
