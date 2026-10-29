// The folders introduced, in the ⚡ Instant tip's style (content-main.ts):
// a first-run tip pointing at "New folder", while there are no folders and
// no storage project; and, before the first change makes that project, the
// terms: what ".phitex-data" is, an animation of where a folder goes, and
// the unofficial extension's as-is terms, agreed to with a tick.

import { h, icon } from "./dom.ts";
import { PROJECT_NAME } from "./project.ts";
import type { View } from "./ui.ts";

const TIP = "phitex-folders-tip";
const CONSENT = "phitex-folders-consent";

/** Shown once per page at most: dismissed, or turned off (`never`, saved by the caller). */
let tipDone = false;

/** The tip, once the dashboard shows "New folder" and there's nothing yet to keep. */
export function folderTip(v: View, never: () => void): void {
  const anchor = document.querySelector<HTMLElement>(".olf-new-folder");
  if (tipDone || document.getElementById(TIP) || document.getElementById(CONSENT) || !anchor?.offsetParent) return;
  if (!v.ready || !v.browsing || v.stored || Object.keys(v.state.folders).length) return;
  tipDone = true;
  addStyle();
  anchor.classList.add("phitex-folders-pulse");
  const yes = h("button", { type: "button", class: "btn btn-primary btn-sm" }, icon("create_new_folder"), " New folder");
  const no = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Not now");
  const off = h("button", { type: "button", class: "btn btn-link btn-sm phitex-folders-never" }, "Don't show again");
  const t = h("div", { id: TIP, class: "popover bs-popover-bottom show", role: "dialog", "aria-label": "Try folders" },
    h("div", { class: "phitex-folders-clip" },
      h("div", { class: "popover-header" }, h("span", { class: "phitex-folders-wiggle", "aria-hidden": "true" }, icon("folder")), "New: folders for your projects"),
      h("div", { class: "popover-body" },
        "Sort your projects into ", h("b", {}, "nested folders"), ": drag a row onto a folder. They follow you to every browser you sign in on.",
        demo(),
        h("div", { class: "small phitex-folders-muted" }, "From PhiTeX Instant, an unofficial browser extension: not an Overleaf feature."),
        h("div", { class: "phitex-folders-actions" }, off, no, yes))));
  document.body.append(t);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = t.offsetWidth;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    t.style.left = `${left}px`;
    t.style.top = `${r.bottom + 10}px`;
    t.style.setProperty("--arrow", `${r.left + r.width / 2 - left}px`);
  };
  place();
  addEventListener("resize", place);
  // (a click anywhere else, "New folder" itself too: the tip goes, as a popover does)
  const away = (e: Event) => {
    if (!t.contains(e.target as Node)) hide();
  };
  document.addEventListener("pointerdown", away, true);
  const hide = () => {
    t.remove();
    anchor.classList.remove("phitex-folders-pulse");
    removeEventListener("resize", place);
    document.removeEventListener("pointerdown", away, true);
  };
  yes.onclick = () => (hide(), v.create(null));
  no.onclick = hide;
  off.onclick = () => (hide(), never());
}

const SEARCH_TIP = "phitex-search-tip";
/** When the search tip may show: 20 s after there are folders to search, in this page. */
let searchAt = 0;

/**
 * The search, introduced once there's something to search: 20 s after the
 * dashboard first has folders (the first one just made, or there before),
 * a tip in the folders tip's style points at the search box, its demo a
 * misspelled name and an owner found. Shown once (`seen`, saved by the
 * caller); never over another tip or a dialog.
 */
export function searchTip(v: View, seen: () => void): void {
  if (!v.ready || !v.browsing || !Object.keys(v.state.folders).length) return;
  if (!searchAt) {
    searchAt = Date.now() + 20_000;
    // (drawn again then: the dashboard may be quiet by that time)
    setTimeout(() => searchTip(v, seen), 20_500);
    return;
  }
  const anchor = document.querySelector<HTMLElement>(".olf-search");
  if (Date.now() < searchAt || !anchor?.offsetParent || document.getElementById(SEARCH_TIP)) return;
  if (document.getElementById(TIP) || document.getElementById(CONSENT) || document.querySelector(".modal.show")) return;
  searchAt = Infinity;
  seen();
  addStyle();
  const input = anchor.querySelector<HTMLInputElement>("input");
  const yes = h("button", { type: "button", class: "btn btn-primary btn-sm" }, icon("search"), " Try it");
  const no = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Got it");
  const row = (k: string, what: string) => h("li", {}, h("code", {}, k), " ", what);
  const t = h("div", { id: SEARCH_TIP, class: "popover bs-popover-bottom show phitex-folders-pop", role: "dialog", "aria-label": "Search your projects" },
    h("div", { class: "phitex-folders-clip" },
      h("div", { class: "popover-header" }, h("span", { class: "phitex-folders-wiggle", "aria-hidden": "true" }, icon("search")), "Search that forgives"),
      h("div", { class: "popover-body" },
        "Typos are fine, and folders are searched too. Narrow with filters, suggested as you type:",
        h("div", { class: "phitex-search-demo", "aria-hidden": "true" },
          h("div", { class: "phitex-search-box" }, icon("search"), h("span", { class: "phitex-search-typed" }, "reserch @moh")),
          h("div", { class: "phitex-search-hit" }, icon("folder"), h("mark", {}, "Research"), h("span", { class: "phitex-search-owner" }, "Mohamed B."))),
        h("ul", { class: "phitex-search-keys" }, row("@name", "owner"), row("#tag", "tag"), row("in:folder", "under a folder"), row("after:7d", "modified since"), row("status:", "its status"), row("-#tag", "not")),
        h("div", { class: "phitex-folders-actions" }, no, yes))));
  document.body.append(t);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = t.offsetWidth;
    const left = Math.max(8, Math.min(r.left + 40 - w / 2, innerWidth - w - 8));
    t.style.left = `${left}px`;
    t.style.top = `${r.bottom + 10}px`;
    t.style.setProperty("--arrow", `${r.left + 40 - left}px`);
  };
  place();
  addEventListener("resize", place);
  const away = (e: Event) => {
    if (!t.contains(e.target as Node)) hide();
  };
  document.addEventListener("pointerdown", away, true);
  const hide = () => {
    t.remove();
    removeEventListener("resize", place);
    document.removeEventListener("pointerdown", away, true);
  };
  no.onclick = hide;
  yes.onclick = () => {
    hide();
    input?.focus();
  };
}

/** A project row going into a folder, over and over. */
const demo = () =>
  h("div", { class: "phitex-folders-demo", "aria-hidden": "true" },
    h("span", { class: "phitex-folders-row" }, icon("description"), "Thesis"),
    h("span", { class: "phitex-folders-into" }, icon("folder"), icon("folder_open")),
    h("span", { class: "phitex-folders-name" }, "Research"));

/**
 * Before the storage project is made: what it is, and the terms. True: the
 * user ticked and agreed (the first change then makes the project).
 */
export function folderConsent(): Promise<boolean> {
  document.getElementById(TIP)?.remove();
  document.querySelector(".phitex-folders-pulse")?.classList.remove("phitex-folders-pulse");
  addStyle();
  return new Promise((done) => {
    const check = h("input", { class: "form-check-input", type: "checkbox", id: `${CONSENT}-check` });
    const ok = h("button", { type: "button", class: "btn btn-primary", disabled: "" }, "Create ", h("code", {}, PROJECT_NAME));
    const cancel = h("button", { type: "button", class: "btn btn-secondary" }, "Cancel");
    const file = (s: string) => h("code", {}, s);
    const modal = h("div", { class: "modal fade show d-block project-list-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": `${CONSENT}-title`, tabindex: "-1" },
      h("div", { class: "modal-dialog modal-dialog-centered modal-lg" }, h("div", { class: "modal-content" },
        h("div", { class: "modal-header phitex-folders-head" }, h("h4", { class: "modal-title", id: `${CONSENT}-title` }, icon("folder"), " Folders: kept in a project of your own")),
        h("div", { class: "modal-body" },
          stage(),
          h("p", {}, "To keep your folders, ", h("b", {}, "one project is created in your Overleaf account: "), file(PROJECT_NAME), ". It holds ",
            file("data/folders.json"), ": your folders' names, how they nest, which project is in which, and their statuses. ",
            "Nothing of your projects is copied into it, no files and no text."),
          h("ul", { class: "phitex-folders-points" },
            h("li", {}, icon("devices"), h("span", {}, h("b", {}, "It follows you: "), "every browser you sign in to Overleaf on shows the same folders.")),
            h("li", {}, icon("history"), h("span", {}, h("b", {}, "Every change is a version "), "in its History: restore an older one from there.")),
            h("li", {}, icon("visibility"), h("span", {}, h("b", {}, "In your project list, as any project. "), "Its ", file("main.tex"), " explains it to whoever opens it. The extension's settings can hide it there. To remove everything, delete it.")),
            h("li", {}, icon("lock"), h("span", {}, h("b", {}, "Only on overleaf.com: "), "the folders are read and saved there, by Overleaf's own requests, and sent nowhere else."))),
          h("p", { class: "small text-muted mb-0" }, "Folders are part of ", h("b", {}, "PhiTeX Instant"),
            ", an unofficial, experimental browser extension, not made, endorsed or supported by Overleaf. Free software under the GNU AGPL, version 3 only, provided as is, without any warranty."),
          h("div", { class: "form-check" }, check,
            h("label", { class: "form-check-label", for: `${CONSENT}-check` }, "I understand this is an unofficial extension, provided as is, without any warranty, and that it creates the project ",
              file(PROJECT_NAME), " in my Overleaf account."))),
        h("div", { class: "modal-footer" }, cancel, ok))));
    const backdrop = h("div", { class: "modal-backdrop fade show" });
    const root = h("div", { id: CONSENT }, backdrop, modal);
    check.onchange = () => ok.toggleAttribute("disabled", !check.checked);
    const finish = (yes: boolean) => {
      root.remove();
      document.body.classList.remove("modal-open");
      done(yes);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    modal.onkeydown = (e) => {
      if (e.key === "Escape") finish(false);
    };
    document.body.append(root);
    document.body.classList.add("modal-open");
    check.focus();
  });
}

/** Where a folder goes: a project into a folder, the folders saved to the project, read by each browser. */
const stage = () =>
  h("div", { class: "phitex-folders-stage", "aria-hidden": "true" },
    h("div", { class: "phitex-folders-list" },
      h("span", { class: "phitex-folders-row" }, icon("description"), "Thesis"),
      h("span", { class: "phitex-folders-into" }, icon("folder"), icon("folder_open")),
      h("span", { class: "phitex-folders-name" }, "Research")),
    h("span", { class: "phitex-folders-wire w1" }, h("i", {})),
    h("div", { class: "phitex-folders-store" }, icon("folder_special"), h("b", {}, PROJECT_NAME), h("small", {}, "data/folders.json"),
      h("span", { class: "phitex-folders-dots" }, h("i", {}), h("i", {}), h("i", {}), h("i", { class: "now" }))),
    h("span", { class: "phitex-folders-wire w2" }, h("i", {})),
    h("div", { class: "phitex-folders-devices" }, icon("laptop_mac"), icon("desktop_windows"), icon("tablet_mac")));

function addStyle() {
  if (document.getElementById("phitex-folders-style")) return;
  const s = h("style", { id: "phitex-folders-style" });
  s.textContent = `
  #${SEARCH_TIP} { position: fixed; z-index: 1060; width: 340px; max-width: calc(100vw - 16px); overflow: visible; color: #f4f5f6; background: #1b222c;
    border: 1.5px solid #53b57f; border-radius: 12px;
    box-shadow: 0 0 0 4px rgb(83 181 127 / 18%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 32px rgb(83 181 127 / 35%);
    animation: phitex-folders-in .6s cubic-bezier(.18,1.5,.4,1), phitex-folders-glow 2.4s ease-in-out .6s infinite; }
  #${SEARCH_TIP}::before { content: ""; position: absolute; top: -8px; left: var(--arrow, 50%); width: 14px; height: 14px; transform: translateX(-50%) rotate(45deg);
    background: #098842; border-left: 1.5px solid #53b57f; border-top: 1.5px solid #53b57f; }
  #${SEARCH_TIP} .phitex-folders-clip { position: relative; overflow: hidden; border-radius: 11px; }
  #${SEARCH_TIP} .phitex-folders-clip::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 22%) 50%, transparent 65%); transform: translateX(-120%);
    animation: phitex-folders-shimmer 2.8s ease-in-out 1s infinite; }
  #${SEARCH_TIP} .popover-header { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; color: #fff; border: 0; padding: 10px 14px;
    background: linear-gradient(135deg, #098842, #1e6b41); }
  #${SEARCH_TIP} .popover-body { color: #f4f5f6; font-size: 14px; }
  #${SEARCH_TIP} .phitex-folders-wiggle { display: inline-flex; animation: phitex-folders-wiggle 1.6s ease-in-out .5s 2; transform-origin: 50% 70%; }
  .phitex-search-demo { margin: 10px 0 6px; padding: 10px; border-radius: 8px; background: rgb(0 0 0 / 22%); font-size: 13px; }
  .phitex-search-box { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; background: #fff; color: #1b222c; }
  .phitex-search-box .material-symbols { font-size: 16px; color: #5a6578; }
  .phitex-search-typed { display: inline-block; overflow: hidden; white-space: nowrap; border-right: 2px solid currentColor; width: 0;
    font-family: "DM Mono", monospace; animation: phitex-search-type 4s steps(12) 1s infinite; }
  .phitex-search-hit { display: flex; align-items: center; gap: 6px; margin-top: 8px; opacity: 0; animation: phitex-search-show 4s steps(1) 1s infinite; }
  .phitex-search-hit .material-symbols { font-size: 18px; color: #53b57f; font-variation-settings: "FILL" 1; }
  .phitex-search-hit mark { padding: 0 2px; border-radius: 3px; color: inherit; background: rgb(255 199 0 / 45%); }
  .phitex-search-owner { margin-left: auto; font-size: 12px; color: #afb5c0; }
  .phitex-search-keys { list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; margin: 6px 0 0; padding: 0; font-size: 12px; color: #afb5c0; }
  .phitex-search-keys code { color: #86caa5; background: rgb(0 0 0 / 22%); padding: 0 4px; border-radius: 4px; }
  @keyframes phitex-search-type { 0% { width: 0; } 55%, 100% { width: 12ch; } }
  @keyframes phitex-search-show { 0%, 30% { opacity: 0; } 31%, 100% { opacity: 1; } }
  #${TIP} { position: fixed; z-index: 1060; width: 340px; max-width: calc(100vw - 16px); overflow: visible; color: #f4f5f6; background: #1b222c;
    border: 1.5px solid #53b57f; border-radius: 12px;
    box-shadow: 0 0 0 4px rgb(83 181 127 / 18%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 32px rgb(83 181 127 / 35%);
    animation: phitex-folders-in .6s cubic-bezier(.18,1.5,.4,1), phitex-folders-glow 2.4s ease-in-out .6s infinite; }
  #${TIP}::before { content: ""; position: absolute; top: -8px; left: var(--arrow, 50%); width: 14px; height: 14px; transform: translateX(-50%) rotate(45deg);
    background: #098842; border-left: 1.5px solid #53b57f; border-top: 1.5px solid #53b57f; }
  #${TIP} .phitex-folders-clip { position: relative; overflow: hidden; border-radius: 11px; }
  #${TIP} .phitex-folders-clip::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 22%) 50%, transparent 65%); transform: translateX(-120%);
    animation: phitex-folders-shimmer 2.8s ease-in-out 1s infinite; }
  #${TIP} .popover-header, #${CONSENT} .phitex-folders-head { display: flex; align-items: center; gap: 8px; font-weight: 700; color: #fff; border: 0;
    background: linear-gradient(135deg, #098842, #1e6b41); }
  #${TIP} .popover-header { font-size: 16px; padding: 10px 14px; }
  #${CONSENT} .phitex-folders-head .modal-title { display: flex; align-items: center; gap: 8px; color: #fff; }
  #${TIP} .popover-body { color: #f4f5f6; font-size: 14px; }
  #${TIP} .phitex-folders-muted { margin-top: 6px; color: #afb5c0; }
  #${TIP} .phitex-folders-wiggle { display: inline-flex; animation: phitex-folders-wiggle 1.6s ease-in-out .5s 2; transform-origin: 50% 70%; }
  #${TIP} .phitex-folders-wiggle .material-symbols { font-size: 22px; font-variation-settings: "FILL" 1; }
  .phitex-folders-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 10px; }
  .phitex-folders-actions .btn .material-symbols { font-size: 16px; vertical-align: -3px; }
  .phitex-folders-actions .btn { white-space: nowrap; flex: none; }
  /* (the link takes what the buttons leave, its words wrapping there) */
  #${TIP} .phitex-folders-actions .phitex-folders-never { flex: 1 1 0; min-width: 0; white-space: normal; text-align: left; padding: 0;
    color: #8d96a5; text-decoration: none; font-size: 12px; }
  #${TIP} .phitex-folders-never:hover { color: #f4f5f6; text-decoration: underline; }
  .phitex-folders-pulse { position: relative; }
  .phitex-folders-pulse::after { content: ""; position: absolute; inset: -3px; border-radius: 9999px; pointer-events: none;
    box-shadow: 0 0 0 0 rgb(83 181 127 / 90%); animation: phitex-folders-ring 1.3s ease-out infinite; }

  /* the demo: a row into a folder (the tip's, and the terms' stage's first part) */
  .phitex-folders-demo, .phitex-folders-list { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .phitex-folders-demo { margin: 10px 0 4px; padding: 10px; border-radius: 8px; background: rgb(0 0 0 / 22%); }
  .phitex-folders-row { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; color: #1b222c; background: #fff;
    box-shadow: 0 2px 6px rgb(0 0 0 / 30%); animation: phitex-folders-drag 3s cubic-bezier(.5,0,.3,1) 1s infinite; }
  .phitex-folders-row .material-symbols { font-size: 16px; color: #5a6578; }
  .phitex-folders-into { position: relative; display: inline-flex; width: 26px; height: 26px; margin-left: 42px; color: #53b57f; }
  .phitex-folders-into .material-symbols { position: absolute; inset: 0; font-size: 26px; font-variation-settings: "FILL" 1; }
  .phitex-folders-into .material-symbols:last-child { opacity: 0; }
  .phitex-folders-into .material-symbols:first-child { animation: phitex-folders-shut 3s steps(1) 1s infinite; }
  .phitex-folders-into .material-symbols:last-child { animation: phitex-folders-open 3s steps(1) 1s infinite; }
  .phitex-folders-into { animation: phitex-folders-gulp 3s ease-out 1s infinite; }
  .phitex-folders-name { font-weight: 600; }
  @keyframes phitex-folders-drag { 0%, 10% { transform: none; opacity: 1; } 45% { transform: translate(72px, -4px) rotate(4deg) scale(.9); opacity: 1; }
    55% { transform: translate(88px, 0) scale(.3); opacity: 0; } 56%, 85% { transform: none; opacity: 0; } 100% { opacity: 1; } }
  @keyframes phitex-folders-open { 0%, 30% { opacity: 0; } 31%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
  @keyframes phitex-folders-shut { 0%, 30% { opacity: 1; } 31%, 55% { opacity: 0; } 56%, 100% { opacity: 1; } }
  @keyframes phitex-folders-gulp { 0%, 52% { transform: none; } 58% { transform: scale(1.25); } 66%, 100% { transform: none; } }

  /* the terms' stage: the list, its folders saved to the project, the project read by each browser */
  #${CONSENT} .modal { z-index: 1070; } #${CONSENT} .modal-backdrop { z-index: 1065; }
  #${CONSENT} .form-check { margin-top: 12px; }
  #${CONSENT} code { font-size: .92em; color: #098842; background: rgb(9 136 66 / 8%); padding: 0 4px; border-radius: 4px; }
  #${CONSENT} .btn code { color: inherit; background: rgb(255 255 255 / 18%); }
  .phitex-folders-stage { display: grid; grid-template-columns: auto 1fr auto 1fr auto; align-items: center; gap: 8px; margin: 0 0 16px; padding: 16px;
    border-radius: 10px; color: #f4f5f6; background: radial-gradient(120% 140% at 0% 0%, #2f3a4c, #1b222c); position: relative; overflow: hidden; }
  .phitex-folders-stage::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 10%) 50%, transparent 65%); transform: translateX(-120%);
    animation: phitex-folders-shimmer 3.6s ease-in-out 1s infinite; }
  .phitex-folders-wire { position: relative; height: 2px; background: rgb(83 181 127 / 35%); border-radius: 2px; }
  .phitex-folders-wire i { position: absolute; top: -3px; left: 0; width: 8px; height: 8px; border-radius: 50%; background: #53b57f;
    box-shadow: 0 0 10px #53b57f; opacity: 0; }
  .phitex-folders-wire.w1 i { animation: phitex-folders-travel 3s ease-in-out 1s infinite; }
  .phitex-folders-wire.w2 i { animation: phitex-folders-travel 3s ease-in-out 1.9s infinite; }
  .phitex-folders-store { display: grid; justify-items: center; gap: 1px; padding: 8px 14px; border-radius: 10px; border: 1.5px solid #53b57f;
    background: rgb(9 136 66 / 18%); box-shadow: 0 0 24px rgb(83 181 127 / 30%); animation: phitex-folders-save 3s ease-out 1s infinite; }
  .phitex-folders-store .material-symbols { font-size: 28px; color: #53b57f; font-variation-settings: "FILL" 1; }
  .phitex-folders-store b { font-family: "DM Mono", monospace; font-size: 13px; }
  .phitex-folders-store small { font-family: "DM Mono", monospace; font-size: 11px; color: #afb5c0; }
  .phitex-folders-dots { display: flex; gap: 5px; margin-top: 4px; }
  .phitex-folders-dots i { width: 6px; height: 6px; border-radius: 50%; background: rgb(83 181 127 / 40%); }
  .phitex-folders-dots i.now { background: #53b57f; animation: phitex-folders-blink 3s steps(1) 1s infinite; }
  .phitex-folders-devices { display: grid; gap: 4px; color: #86caa5; }
  .phitex-folders-devices .material-symbols { font-size: 22px; animation: phitex-folders-lit 3s ease-out 2.2s infinite; }
  .phitex-folders-devices .material-symbols:nth-child(2) { animation-delay: 2.35s; }
  .phitex-folders-devices .material-symbols:nth-child(3) { animation-delay: 2.5s; }
  .phitex-folders-points { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 6px; }
  .phitex-folders-points li { display: flex; gap: 10px; align-items: flex-start; }
  .phitex-folders-points .material-symbols { color: #098842; font-size: 20px; }
  @keyframes phitex-folders-travel { 0%, 50% { left: 0; opacity: 0; } 55% { opacity: 1; } 80% { left: calc(100% - 8px); opacity: 1; } 85%, 100% { left: calc(100% - 8px); opacity: 0; } }
  @keyframes phitex-folders-save { 0%, 78% { transform: none; } 84% { transform: scale(1.07); box-shadow: 0 0 36px rgb(83 181 127 / 60%); } 92%, 100% { transform: none; } }
  @keyframes phitex-folders-blink { 0%, 80% { opacity: .2; } 81%, 100% { opacity: 1; } }
  @keyframes phitex-folders-lit { 0%, 20% { color: #86caa5; transform: none; } 6% { color: #fff; transform: scale(1.2); } }

  @keyframes phitex-folders-in { 0% { opacity: 0; transform: translateY(18px) scale(.85); } 60% { opacity: 1; } }
  @keyframes phitex-folders-shimmer { 0% { transform: translateX(-120%); } 45%, 100% { transform: translateX(120%); } }
  @keyframes phitex-folders-glow { 50% { box-shadow: 0 0 0 6px rgb(83 181 127 / 10%), 0 18px 48px rgb(0 0 0 / 45%), 0 0 44px rgb(83 181 127 / 55%); } }
  @keyframes phitex-folders-wiggle { 0%, 100% { transform: rotate(0); } 10%, 30%, 50% { transform: rotate(-14deg) scale(1.15); } 20%, 40% { transform: rotate(14deg) scale(1.15); } 60% { transform: rotate(0); } }
  @keyframes phitex-folders-ring { 70% { box-shadow: 0 0 0 14px rgb(83 181 127 / 0%); } 100% { box-shadow: 0 0 0 0 rgb(83 181 127 / 0%); } }
  @media (max-width: 575px) { .phitex-folders-stage { grid-template-columns: 1fr; justify-items: center; } .phitex-folders-wire { width: 2px; height: 18px; } }
  @media (prefers-reduced-motion: reduce) {
    .phitex-search-typed { width: 12ch; } .phitex-search-hit { opacity: 1; }
    #${SEARCH_TIP}, #${SEARCH_TIP} *, #${SEARCH_TIP} .phitex-folders-clip::after, .phitex-folders-stage *, .phitex-folders-stage::after, .phitex-folders-pulse::after { animation: none !important; }
    .phitex-folders-wire i { opacity: 1; left: calc(50% - 4px); }
  }`;
  (document.head ?? document.documentElement).append(s);
}
