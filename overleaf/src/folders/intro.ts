// The folders introduced (callout.ts's popovers, as the editor's tips): a
// first-run tip pointing at "New folder", while there are no folders and no
// storage project; once there are folders, a tip for the search; and,
// before the first change makes that project, what ".phitex-data" is, an
// animation of where a folder goes, and the extension's terms (terms.ts:
// one acceptance with ⚡ Instant's, asked only if not given yet).

import { callout, calloutStyle } from "../callout.ts";
import { h, icon } from "../dom.ts";
import { AGREE, asIs } from "../terms.ts";
import { PROJECT_NAME } from "./project.ts";
import type { View } from "./ui.ts";

const TIP = "phitex-folders-tip";
const SEARCH_TIP = "phitex-search-tip";
const CONSENT = "phitex-folders-consent";

/** Shown once per page at most: dismissed, or turned off (`never`, saved by the caller). */
let tipDone = false;

/** Another of ours up (a tip, the terms, a dialog): a tip waits. */
const busy = () => !!(document.getElementById(TIP) || document.getElementById(SEARCH_TIP) || document.getElementById(CONSENT) || document.querySelector(".modal.show"));

/** The tip, once the dashboard shows "New folder" and there's nothing yet to keep. */
export function folderTip(v: View, never: () => void): void {
  // (called at every drawing: what costs nothing first, the layout (offsetParent) last)
  if (tipDone || !v.ready || !v.browsing || v.stored || Object.keys(v.state.folders).length) return;
  const anchor = document.querySelector<HTMLElement>(".olf-new-folder");
  if (!anchor || busy() || !anchor.offsetParent) return;
  tipDone = true;
  addStyle();
  const yes = h("button", { type: "button", class: "btn btn-primary btn-sm" }, icon("create_new_folder"), " New folder");
  const no = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Not now");
  const off = h("button", { type: "button", class: "btn btn-link btn-sm phitex-callout-never" }, "Don't show again");
  const c = callout({
    id: TIP,
    label: "Try folders",
    anchor,
    shiny: true,
    width: 340,
    dismissOnOutside: true,
    header: [h("span", { class: "phitex-callout-icon", "aria-hidden": "true" }, icon("folder")), "New: folders for your projects"],
    body: [
      "Sort your projects into ", h("b", {}, "nested folders"), ": drag a row onto a folder. They follow you to every browser you sign in on.",
      h("div", { class: "phitex-callout-demo phitex-folders-demo", "aria-hidden": "true" }, ...dropping()),
      h("div", { class: "small phitex-callout-muted", style: "margin-top:6px" }, "From PhiTeX Instant, an unofficial browser extension: not an Overleaf feature."),
    ],
    actions: [off, no, yes],
  });
  yes.onclick = () => (c.hide(), v.create(null));
  no.onclick = () => c.hide();
  off.onclick = () => (c.hide(), never());
}

/** When the search tip may show: 20 s after there are folders to search, in this page. */
let searchAt = 0;

/**
 * The search, introduced once there's something to search: 20 s after the
 * dashboard first has folders (the first one just made, or there before),
 * a tip points at the search box, its demo a misspelled name and an owner
 * found. Shown once (`seen`, saved by the caller).
 */
export function searchTip(v: View, seen: () => void): void {
  // (called at every drawing: what costs nothing first)
  if (searchAt === Infinity || !v.ready || !v.browsing || !Object.keys(v.state.folders).length) return;
  if (!searchAt) {
    searchAt = Date.now() + 20_000;
    // (drawn again then: the dashboard may be quiet by that time)
    setTimeout(() => searchTip(v, seen), 20_500);
    return;
  }
  if (Date.now() < searchAt) return;
  const anchor = document.querySelector<HTMLElement>(".olf-search");
  if (!anchor || busy() || !anchor.offsetParent) return;
  searchAt = Infinity;
  seen();
  addStyle();
  const yes = h("button", { type: "button", class: "btn btn-primary btn-sm" }, icon("search"), " Try it");
  const no = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Got it");
  const key = (k: string, what: string) => h("li", {}, h("code", {}, k), " ", what);
  const c = callout({
    id: SEARCH_TIP,
    label: "Search your projects",
    anchor,
    arrowAt: 40,
    shiny: true,
    pulse: null,
    width: 340,
    dismissOnOutside: true,
    header: [h("span", { class: "phitex-callout-icon", "aria-hidden": "true" }, icon("search")), "Search that forgives"],
    body: [
      "Typos are fine, and folders are searched too. Narrow with filters, suggested as you type:",
      h("div", { class: "phitex-callout-demo", "aria-hidden": "true" },
        h("div", { class: "phitex-search-box" }, icon("search"), h("span", { class: "phitex-callout-typed", style: "--n: 12" }, "reserch @moh")),
        h("div", { class: "phitex-search-hit" }, icon("folder"), h("mark", {}, "Research"), h("span", { class: "phitex-search-owner" }, "Mohamed B."))),
      h("ul", { class: "phitex-search-keys" }, key("@name", "owner"), key("#tag", "tag"), key("in:folder", "under a folder"), key("after:7d", "modified since"), key("status:", "its status"), key("-#tag", "not")),
    ],
    actions: [no, yes],
  });
  no.onclick = () => c.hide();
  yes.onclick = () => {
    c.hide();
    anchor.querySelector("input")?.focus();
  };
}

/** A project row going into a folder, over and over. */
const dropping = () => [
  h("span", { class: "phitex-folders-row" }, icon("description"), "Thesis"),
  h("span", { class: "phitex-folders-into" }, icon("folder"), icon("folder_open")),
  h("span", { class: "phitex-folders-name" }, "Research"),
];

/** The extension's terms, as the page knows them (the settings bridge's: dashboard.ts). */
export type Terms = { accepted: boolean; license: string; accept(): void };

/**
 * Before the storage project is made: what it is, and the extension's
 * terms if not accepted yet (for ⚡ Instant too, then). True: the user
 * agreed (the first change then makes the project). With the project
 * there (`exists`: the terms withdrawn since), the terms alone.
 */
export function folderConsent(terms: Terms, exists = false): Promise<boolean> {
  for (const id of [TIP, SEARCH_TIP]) document.getElementById(id)?.remove();
  document.querySelector(".phitex-pulse")?.classList.remove("phitex-pulse");
  addStyle();
  return new Promise((done) => {
    const check = h("input", { class: "form-check-input", type: "checkbox", id: `${CONSENT}-check` });
    const ok = h("button", { type: "button", class: "btn btn-primary" }, ...(exists ? ["Accept"] : ["Create ", h("code", {}, PROJECT_NAME)]));
    if (!terms.accepted) ok.setAttribute("disabled", "");
    const cancel = h("button", { type: "button", class: "btn btn-secondary" }, "Cancel");
    const file = (s: string) => h("code", {}, s);
    const license = h("p", { class: "small text-muted mb-0" });
    license.innerHTML = asIs(terms.license);
    const modal = h("div", { class: "modal fade show d-block project-list-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": `${CONSENT}-title`, tabindex: "-1" },
      h("div", { class: "modal-dialog modal-dialog-centered modal-lg" }, h("div", { class: "modal-content" },
        h("div", { class: "modal-header phitex-folders-head" }, h("h4", { class: "modal-title", id: `${CONSENT}-title` }, icon("folder"), exists ? " Folders: the terms, again" : " Folders: kept in a project of your own")),
        exists
          ? h("div", { class: "modal-body" },
              h("p", {}, "You withdrew your acceptance of ", h("b", {}, "PhiTeX Instant"), "'s terms. Your folders are still there, in ", file(PROJECT_NAME), "; to change them, accept the terms again."),
              h("p", { class: "small text-muted" }, "Folders are part of ", h("b", {}, "PhiTeX Instant"), ", an unofficial, experimental browser extension, not made, endorsed or supported by Overleaf."),
              license,
              h("div", { class: "form-check" }, check, h("label", { class: "form-check-label", for: `${CONSENT}-check` }, AGREE)))
          : h("div", { class: "modal-body" },
          stage(),
          h("p", {}, "To keep your folders, ", h("b", {}, "one project is created in your Overleaf account: "), file(PROJECT_NAME), ". It holds ",
            file("data/folders.json"), ": your folders' names, how they nest, which project is in which, and their statuses. ",
            "Nothing of your projects is copied into it, no files and no text."),
          h("ul", { class: "phitex-folders-points" },
            h("li", {}, icon("devices"), h("span", {}, h("b", {}, "It follows you: "), "every browser you sign in to Overleaf on shows the same folders.")),
            h("li", {}, icon("history"), h("span", {}, h("b", {}, "Every change is a version "), "in its History: restore an older one from there.")),
            h("li", {}, icon("visibility"), h("span", {}, h("b", {}, "In your project list, as any project. "), "Its ", file("main.tex"), " explains it to whoever opens it. The extension's settings can hide it there. To remove everything, delete it.")),
            h("li", {}, icon("lock"), h("span", {}, h("b", {}, "Only on overleaf.com: "), "the folders are read and saved there, by Overleaf's own requests, and sent nowhere else."))),
          ...(terms.accepted
            ? [h("p", { class: "small text-muted mb-0" }, "Folders are part of ", h("b", {}, "PhiTeX Instant"), ", whose terms you accepted: unofficial, experimental, provided as is.")]
            : [
                h("p", { class: "small text-muted" }, "Folders are part of ", h("b", {}, "PhiTeX Instant"), ", an unofficial, experimental browser extension, not made, endorsed or supported by Overleaf."),
                license,
                h("div", { class: "form-check" }, check, h("label", { class: "form-check-label", for: `${CONSENT}-check` }, AGREE)),
              ])),
        h("div", { class: "modal-footer" }, cancel, ok))));
    const backdrop = h("div", { class: "modal-backdrop fade show" });
    const root = h("div", { id: CONSENT }, backdrop, modal);
    check.onchange = () => ok.toggleAttribute("disabled", !check.checked);
    const finish = (yes: boolean) => {
      root.remove();
      document.body.classList.remove("modal-open");
      if (yes && !terms.accepted) terms.accept();
      done(yes);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    modal.onkeydown = (e) => {
      if (e.key === "Escape") finish(false);
    };
    document.body.append(root);
    document.body.classList.add("modal-open");
    (terms.accepted ? ok : check).focus();
  });
}

/** Where a folder goes: a project into a folder, the folders saved to the project, read by each browser. */
const stage = () =>
  h("div", { class: "phitex-folders-stage", "aria-hidden": "true" },
    h("div", { class: "phitex-folders-list" }, ...dropping()),
    h("span", { class: "phitex-folders-wire w1" }, h("i", {})),
    h("div", { class: "phitex-folders-store" }, icon("folder_special"), h("b", {}, PROJECT_NAME), h("small", {}, "data/folders.json"),
      h("span", { class: "phitex-folders-dots" }, h("i", {}), h("i", {}), h("i", {}), h("i", { class: "now" }))),
    h("span", { class: "phitex-folders-wire w2" }, h("i", {})),
    h("div", { class: "phitex-folders-devices" }, icon("laptop_mac"), icon("desktop_windows"), icon("tablet_mac")));

/** The demos' and the terms dialog's own styles (the popovers' are callout.ts's). */
function addStyle() {
  calloutStyle();
  if (document.getElementById("phitex-folders-style")) return;
  const s = h("style", { id: "phitex-folders-style" });
  s.textContent = `
  /* a row into a folder: the tip's demo, and the terms' stage's first part */
  .phitex-folders-demo, .phitex-folders-list { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .phitex-folders-row { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; color: #1b222c; background: #fff;
    box-shadow: 0 2px 6px rgb(0 0 0 / 30%); animation: phitex-folders-drag 3s cubic-bezier(.5,0,.3,1) 1s infinite; }
  .phitex-folders-row .material-symbols { font-size: 16px; color: #5a6578; }
  .phitex-folders-into { position: relative; display: inline-flex; width: 26px; height: 26px; margin-left: 42px; color: #5b8fd6;
    animation: phitex-folders-gulp 3s ease-out 1s infinite; }
  .phitex-folders-into .material-symbols { position: absolute; inset: 0; font-size: 26px; font-variation-settings: "FILL" 1; }
  .phitex-folders-into .material-symbols:first-child { animation: phitex-folders-shut 3s steps(1) 1s infinite; }
  .phitex-folders-into .material-symbols:last-child { opacity: 0; animation: phitex-folders-open 3s steps(1) 1s infinite; }
  .phitex-folders-name { font-weight: 600; }
  @keyframes phitex-folders-drag { 0%, 10% { transform: none; opacity: 1; } 45% { transform: translate(72px, -4px) rotate(4deg) scale(.9); opacity: 1; }
    55% { transform: translate(88px, 0) scale(.3); opacity: 0; } 56%, 85% { transform: none; opacity: 0; } 100% { opacity: 1; } }
  @keyframes phitex-folders-open { 0%, 30% { opacity: 0; } 31%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
  @keyframes phitex-folders-shut { 0%, 30% { opacity: 1; } 31%, 55% { opacity: 0; } 56%, 100% { opacity: 1; } }
  @keyframes phitex-folders-gulp { 0%, 52% { transform: none; } 58% { transform: scale(1.25); } 66%, 100% { transform: none; } }

  /* the search tip's demo: a box typed into, the folder found */
  .phitex-search-box { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; background: #fff; color: #1b222c; }
  .phitex-search-box .material-symbols { font-size: 16px; color: #5a6578; }
  .phitex-search-hit { display: flex; align-items: center; gap: 6px; margin-top: 8px; opacity: 0; animation: phitex-search-show 2.4s steps(1) 1s infinite; }
  .phitex-search-hit .material-symbols { font-size: 18px; color: #5b8fd6; font-variation-settings: "FILL" 1; }
  .phitex-search-hit mark { padding: 0 2px; border-radius: 3px; color: inherit; background: rgb(255 199 0 / 45%); }
  .phitex-search-owner { margin-left: auto; font-size: 12px; color: #afb5c0; }
  .phitex-search-keys { list-style: none; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; margin: 6px 0 0; padding: 0; font-size: 12px; color: #afb5c0; }
  @keyframes phitex-search-show { 0%, 55% { opacity: 0; } 56%, 100% { opacity: 1; } }

  /* the terms: their header, the stage (the list, its folders saved to the project, the project read by each browser) */
  #${CONSENT} .modal { z-index: 1070; } #${CONSENT} .modal-backdrop { z-index: 1065; }
  #${CONSENT} .form-check { margin-top: 12px; }
  #${CONSENT} code { font-size: .92em; color: #1d3e72; background: rgb(9 136 66 / 8%); padding: 0 4px; border-radius: 4px; }
  #${CONSENT} .btn code { color: inherit; background: rgb(255 255 255 / 18%); }
  #${CONSENT} .phitex-folders-head { border: 0; color: #fff; background: linear-gradient(135deg, #1d3e72, #16325d); }
  #${CONSENT} .phitex-folders-head .modal-title { display: flex; align-items: center; gap: 8px; color: #fff; }
  .phitex-folders-stage { display: grid; grid-template-columns: auto 1fr auto 1fr auto; align-items: center; gap: 8px; margin: 0 0 16px; padding: 16px;
    border-radius: 10px; color: #f4f5f6; background: radial-gradient(120% 140% at 0% 0%, #2f3a4c, #1b222c); position: relative; overflow: hidden; }
  .phitex-folders-stage::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 35%, rgb(255 255 255 / 10%) 50%, transparent 65%); transform: translateX(-120%);
    animation: phitex-callout-shimmer 3.6s ease-in-out 1s infinite; }
  .phitex-folders-wire { position: relative; height: 2px; background: rgb(91 143 214 / 35%); border-radius: 2px; }
  .phitex-folders-wire i { position: absolute; top: -3px; left: 0; width: 8px; height: 8px; border-radius: 50%; background: #5b8fd6;
    box-shadow: 0 0 10px #5b8fd6; opacity: 0; }
  .phitex-folders-wire.w1 i { animation: phitex-folders-travel 3s ease-in-out 1s infinite; }
  .phitex-folders-wire.w2 i { animation: phitex-folders-travel 3s ease-in-out 1.9s infinite; }
  .phitex-folders-store { display: grid; justify-items: center; gap: 1px; padding: 8px 14px; border-radius: 10px; border: 1.5px solid #5b8fd6;
    background: rgb(9 136 66 / 18%); box-shadow: 0 0 24px rgb(91 143 214 / 30%); animation: phitex-folders-save 3s ease-out 1s infinite; }
  .phitex-folders-store .material-symbols { font-size: 28px; color: #5b8fd6; font-variation-settings: "FILL" 1; }
  .phitex-folders-store b { font-family: "DM Mono", monospace; font-size: 13px; }
  .phitex-folders-store small { font-family: "DM Mono", monospace; font-size: 11px; color: #afb5c0; }
  .phitex-folders-dots { display: flex; gap: 5px; margin-top: 4px; }
  .phitex-folders-dots i { width: 6px; height: 6px; border-radius: 50%; background: rgb(91 143 214 / 40%); }
  .phitex-folders-dots i.now { background: #5b8fd6; animation: phitex-folders-blink 3s steps(1) 1s infinite; }
  .phitex-folders-devices { display: grid; gap: 4px; color: #a9c4f0; }
  .phitex-folders-devices .material-symbols { font-size: 22px; animation: phitex-folders-lit 3s ease-out 2.2s infinite; }
  .phitex-folders-devices .material-symbols:nth-child(2) { animation-delay: 2.35s; }
  .phitex-folders-devices .material-symbols:nth-child(3) { animation-delay: 2.5s; }
  .phitex-folders-points { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 6px; }
  .phitex-folders-points li { display: flex; gap: 10px; align-items: flex-start; }
  .phitex-folders-points .material-symbols { color: #1d3e72; font-size: 20px; }
  @keyframes phitex-folders-travel { 0%, 50% { left: 0; opacity: 0; } 55% { opacity: 1; } 80% { left: calc(100% - 8px); opacity: 1; } 85%, 100% { left: calc(100% - 8px); opacity: 0; } }
  @keyframes phitex-folders-save { 0%, 78% { transform: none; } 84% { transform: scale(1.07); box-shadow: 0 0 36px rgb(91 143 214 / 60%); } 92%, 100% { transform: none; } }
  @keyframes phitex-folders-blink { 0%, 80% { opacity: .2; } 81%, 100% { opacity: 1; } }
  @keyframes phitex-folders-lit { 0%, 20% { color: #a9c4f0; transform: none; } 6% { color: #fff; transform: scale(1.2); } }
  @media (max-width: 575px) { .phitex-folders-stage { grid-template-columns: 1fr; justify-items: center; } .phitex-folders-wire { width: 2px; height: 18px; } }
  @media (prefers-reduced-motion: reduce) {
    .phitex-folders-demo *, .phitex-search-hit, .phitex-folders-stage *, .phitex-folders-stage::after { animation: none !important; }
    .phitex-search-hit { opacity: 1; }
    .phitex-folders-wire i { opacity: 1; left: calc(50% - 4px); }
  }`;
  (document.head ?? document.documentElement).append(s);
}
