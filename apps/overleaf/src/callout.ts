// One popover for everything the extension points out: the first-run tips
// (⚡ Instant's, Compare's, the folders', the search's), what's new, the
// tour's steps. Overleaf's popover markup in PhiTeX's blue, pointing at
// what it is about (below it, or over it near its top), placed again as
// the window resizes; a first-run tip shines (a glow, a sweep of light,
// its icon wiggling, what it points at ringed). Its styles are put in the
// page once, for the editor's content script and the dashboard's page
// script alike (both import this).

import { h } from "./dom.ts";

export type CalloutOptions = {
  /** Its element's id: one of each at a time. */
  id: string;
  /** What a screen reader calls it. */
  label: string;
  anchor: Element;
  /** The header: an icon (`.phitex-callout-icon`, wiggling when shiny), a title, a step count (`.phitex-callout-step`, at the right). */
  header: (Node | string)[];
  /** The body: nodes, or markup (the editor's own tips are written as markup). */
  body: (Node | string)[] | { html: string };
  /** Buttons, at the bottom right; one with class `phitex-callout-never` ("Don't show again", "Skip") at the left. */
  actions?: Node[];
  /** A first-run tip: a glow, a sweep of light, the anchor (or `pulse`) ringed. */
  shiny?: boolean;
  /** Over the anchor near its top, no arrow (a step about a large area: the preview). */
  inside?: boolean;
  /** The arrow's place, px from the anchor's left (default: its middle). */
  arrowAt?: number;
  width?: number;
  /** What is ringed while it shows (default, when shiny: the anchor). */
  pulse?: Element | null;
  /** Gone at a click anywhere else. */
  dismissOnOutside?: boolean;
  onHide?: () => void;
};

export type Callout = { el: HTMLElement; hide(): void };

export function callout(o: CalloutOptions): Callout {
  calloutStyle();
  document.getElementById(o.id)?.remove();
  const body = h("div", { class: "popover-body" });
  if ("html" in o.body) body.innerHTML = o.body.html;
  else body.append(...o.body);
  if (o.actions?.length) body.append(h("div", { class: "phitex-callout-actions" }, ...o.actions));
  const el = h("div", { id: o.id, class: `popover bs-popover-bottom show phitex-callout${o.shiny ? " shiny" : ""}${o.inside ? " inside" : ""}`, role: "dialog", "aria-label": o.label },
    h("div", { class: "phitex-callout-clip" }, h("div", { class: "popover-header" }, ...o.header), body));
  if (o.width) el.style.width = `${o.width}px`;
  document.body.append(el);
  const pulse = o.pulse === undefined ? (o.shiny ? o.anchor : null) : o.pulse;
  pulse?.classList.add("phitex-pulse");
  const place = () => {
    if (!el.isConnected) return hide();
    const r = o.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const at = r.left + (o.arrowAt ?? r.width / 2);
    const left = Math.max(8, Math.min(at - w / 2, innerWidth - w - 8));
    el.style.left = `${left}px`;
    el.style.top = `${o.inside ? r.top + 24 : r.bottom + 10}px`;
    el.style.setProperty("--arrow", `${at - left}px`);
  };
  const away = (e: Event) => {
    if (!el.contains(e.target as Node)) hide();
  };
  let gone = false;
  function hide() {
    if (gone) return;
    gone = true;
    el.remove();
    pulse?.classList.remove("phitex-pulse");
    removeEventListener("resize", place);
    document.removeEventListener("pointerdown", away, true);
    o.onHide?.();
  }
  place();
  addEventListener("resize", place);
  if (o.dismissOnOutside) document.addEventListener("pointerdown", away, true);
  return { el, hide };
}

/** The popovers' styles (their animations too: others use them), in the page once. */
export function calloutStyle() {
  if (document.getElementById("phitex-callout-style")) return;
  const s = h("style", { id: "phitex-callout-style" });
  s.textContent = `
  .phitex-callout { position: fixed; z-index: 1060; width: 320px; max-width: calc(100vw - 16px); overflow: visible; color: #f4f5f6; background: #1b222c;
    border: 1.5px solid #5b8fd6; border-radius: 12px; box-shadow: 0 0 0 4px rgb(91 143 214 / 18%), 0 18px 48px rgb(0 0 0 / 45%);
    animation: phitex-callout-in .35s cubic-bezier(.2,1.3,.4,1); font-size: 14px; }
  .phitex-callout::before { content: ""; position: absolute; top: -8px; left: var(--arrow, 50%); width: 14px; height: 14px; transform: translateX(-50%) rotate(45deg);
    background: #1d3e72; border-left: 1.5px solid #5b8fd6; border-top: 1.5px solid #5b8fd6; }
  .phitex-callout.inside::before { display: none; }
  .phitex-callout .phitex-callout-clip { position: relative; overflow: hidden; border-radius: 11px; }
  .phitex-callout .popover-header { display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 14px; border: 0; font-size: 15px; font-weight: 700;
    color: #fff; background: linear-gradient(135deg, #1d3e72, #16325d); }
  .phitex-callout .popover-body { color: #f4f5f6; padding: 12px 14px; }
  .phitex-callout .popover-body .text-muted, .phitex-callout .phitex-callout-muted { color: #afb5c0 !important; }
  .phitex-callout .popover-body code { color: #a9c4f0; background: rgb(0 0 0 / 22%); padding: 0 4px; border-radius: 4px; }
  .phitex-callout .popover-body a:not(.btn) { color: #a9c4f0; }
  .phitex-callout kbd { font-size: 11px; padding: 1px 4px; }
  .phitex-callout .phitex-callout-step { margin-left: auto; font-size: 11px; font-weight: 600; opacity: .8; white-space: nowrap; }
  .phitex-callout .phitex-callout-icon { display: inline-flex; font-size: 20px; }
  .phitex-callout .phitex-callout-icon .material-symbols { font-size: 22px; font-variation-settings: "FILL" 1; }
  .phitex-callout .phitex-callout-demo { margin: 10px 0 4px; padding: 10px; border-radius: 8px; background: rgb(0 0 0 / 22%); font-size: 13px; }
  .phitex-callout-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
  .phitex-callout-actions .btn { white-space: nowrap; flex: none; }
  .phitex-callout-actions .btn .material-symbols { font-size: 16px; vertical-align: -3px; }
  /* (the left link takes what the buttons leave, its words wrapping there) */
  .phitex-callout-actions .phitex-callout-never { flex: 1 1 0; min-width: 0; white-space: normal; text-align: left; padding: 0;
    color: #8d96a5; text-decoration: none; font-size: 12px; }
  .phitex-callout-actions .phitex-callout-never:hover { color: #f4f5f6; text-decoration: underline; }
  /* a first-run tip: it bounces in, glows, a light sweeps it, its icon wiggles */
  .phitex-callout.shiny { box-shadow: 0 0 0 4px rgb(91 143 214 / 18%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 32px rgb(91 143 214 / 35%);
    animation: phitex-callout-in .6s cubic-bezier(.18,1.5,.4,1), phitex-callout-glow 2.4s ease-in-out .6s infinite; }
  .phitex-callout.shiny .phitex-callout-clip::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 22%) 50%, transparent 65%); transform: translateX(-120%);
    animation: phitex-callout-shimmer 2.8s ease-in-out 1s infinite; }
  .phitex-callout.shiny .phitex-callout-icon { animation: phitex-callout-wiggle 1.6s ease-in-out .5s 2; transform-origin: 50% 70%; }
  /* what a shiny tip points at, ringed */
  .phitex-pulse { position: relative; }
  .phitex-pulse::after { content: ""; position: absolute; inset: -3px; border-radius: 9999px; pointer-events: none;
    box-shadow: 0 0 0 0 rgb(91 143 214 / 90%); animation: phitex-callout-ring 1.3s ease-out infinite; }
  /* a demo's typed text: --n characters, typed again and again */
  .phitex-callout-typed { display: inline-block; overflow: hidden; white-space: nowrap; vertical-align: bottom; border-right: 2px solid currentColor; width: 0;
    font-family: "DM Mono", monospace; animation: phitex-callout-type 2.4s steps(var(--n, 9)) 1s infinite; }
  @keyframes phitex-callout-type { 0% { width: 0; } 55%, 100% { width: calc(var(--n, 9) * 1ch); } }
  @keyframes phitex-callout-in { 0% { opacity: 0; transform: translateY(18px) scale(.85); } 60% { opacity: 1; } }
  @keyframes phitex-callout-shimmer { 0% { transform: translateX(-120%); } 45%, 100% { transform: translateX(120%); } }
  @keyframes phitex-callout-glow { 50% { box-shadow: 0 0 0 6px rgb(91 143 214 / 10%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 44px rgb(91 143 214 / 55%); } }
  @keyframes phitex-callout-wiggle { 0%, 100% { transform: rotate(0); } 10%, 30%, 50% { transform: rotate(-14deg) scale(1.15); } 20%, 40% { transform: rotate(14deg) scale(1.15); } 60% { transform: rotate(0); } }
  @keyframes phitex-callout-ring { 70% { box-shadow: 0 0 0 14px rgb(91 143 214 / 0%); } 100% { box-shadow: 0 0 0 0 rgb(91 143 214 / 0%); } }
  @media (prefers-reduced-motion: reduce) {
    .phitex-callout, .phitex-callout *, .phitex-callout .phitex-callout-clip::after, .phitex-pulse::after { animation: none !important; }
    .phitex-callout-typed { width: calc(var(--n, 9) * 1ch); }
  }`;
  (document.head ?? document.documentElement).append(s);
}
