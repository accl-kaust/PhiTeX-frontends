// Compare with a past version: the toolbar's Compare button (beside the
// download, Overleaf's own dropdown markup), its menu of versions (the
// labels, then the history, older on demand: history.ts), and the tip that
// shows it. The diff bar over the page, its state and keys, are
// common/src/compare.ts's DiffControls; what a diff is made of (the
// phitex-diff markup, typeset) is the runner's: `start` gets the version
// picked.

import type { Panel } from "./common/viewer/panel.ts";
import { DiffControls, type DiffRunner as Runner } from "./common/viewer/compare.ts";
import { type Version, versions } from "./history.ts";
import { ago, h } from "./dom.ts";
import { callout } from "./callout.ts";

export type DiffRunner = Runner<Version>;

/** "Not now": the tip again this much later. */
const SNOOZE_MS = 3 * 24 * 3600 * 1000;
/** After the page settled: not over a load, a tour or the first tip. */
const TIP_DELAY_MS = 20_000;

const TIP_CSS = `
  /* the demo: a page whose sentence changes, then the change marked as latexdiff marks it, then the navigator */
  #phitex-cmptip .cmp-demo { position: relative; margin: 10px 0 4px; padding: 10px 12px 30px; border-radius: 8px; background: #fff; color: #1b222c;
    font: 13px/1.5 "Noto Serif", serif; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 8%); }
  #phitex-cmptip .cmp-demo .del { position: relative; color: #1b222c; animation: cmp-del 6s ease-in-out infinite; }
  #phitex-cmptip .cmp-demo .add { display: inline-block; max-width: 0; overflow: hidden; vertical-align: bottom; white-space: nowrap; color: #1d4ed8;
    text-decoration: underline wavy #1d4ed8; text-underline-offset: 3px; animation: cmp-add 6s ease-in-out infinite; }
  #phitex-cmptip .cmp-demo .tag { position: absolute; right: 8px; bottom: 7px; font: 600 11px/1 system-ui, sans-serif; color: #fff; background: rgb(27 34 44 / 88%);
    border-radius: 9px; padding: 3px 8px; opacity: 0; animation: cmp-tag 6s ease-in-out infinite; }
  #phitex-cmptip .cmp-demo .ver { position: absolute; left: 12px; right: 76px; bottom: 9px; height: 12px; font: 11px/12px system-ui, sans-serif; color: #6b7280; }
  #phitex-cmptip .cmp-demo .ver i { font-style: normal; position: absolute; left: 0; white-space: nowrap; }
  #phitex-cmptip .cmp-demo .ver .v0 { animation: cmp-v0 6s steps(1) infinite; }
  #phitex-cmptip .cmp-demo .ver .v1 { opacity: 0; animation: cmp-v1 6s steps(1) infinite; }
  @keyframes cmp-del { 0%, 30% { color: #1b222c; text-decoration: none; } 40%, 92% { color: #b91c1c; text-decoration: line-through 2px #b91c1c; } 100% { color: #1b222c; } }
  @keyframes cmp-add { 0%, 45% { max-width: 0; } 60%, 92% { max-width: 6em; } 100% { max-width: 0; } }
  @keyframes cmp-tag { 0%, 62% { opacity: 0; transform: translateY(6px); } 70%, 92% { opacity: 1; transform: none; } 100% { opacity: 0; } }
  @keyframes cmp-v0 { 0% { opacity: 1; } 31% { opacity: 0; } }
  @keyframes cmp-v1 { 0% { opacity: 0; } 31% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    #phitex-cmptip, #phitex-cmptip * { animation: none !important; }
    #phitex-cmptip .cmp-demo .del { color: #b91c1c; text-decoration: line-through 2px #b91c1c; }
    #phitex-cmptip .cmp-demo .add { max-width: 6em; } #phitex-cmptip .cmp-demo .tag { opacity: 1; }
    #phitex-cmptip .cmp-demo .ver .v0 { opacity: 0; } #phitex-cmptip .cmp-demo .ver .v1 { opacity: 1; }
  }`;

/**
 * The compare tip: a shiny callout (callout.ts, the first-run tip's look) pointing at
 * the Compare button, with a demo of a diff. Shown TIP_DELAY_MS after the
 * document's first pages are drawn, while Compare was never used; "Not now" brings it back
 * SNOOZE_MS later, "Don't show again" (or using Compare) never. Never over
 * another of ours (terms, tip, news, tour).
 */
function compareTip(btn: HTMLButtonElement): void {
  setTimeout(async () => {
    const st = (await chrome.storage.local.get(["cmpUsed", "cmpTipOff", "cmpTipNext"])) as { cmpUsed?: boolean; cmpTipOff?: boolean; cmpTipNext?: number };
    if (st.cmpUsed || st.cmpTipOff || (st.cmpTipNext ?? 0) > Date.now()) return;
    const busy = ["phitex-consent", "phitex-tip", "phitex-news", "phitex-tour", "phitex-cmptip"].some((id) => document.getElementById(id));
    // (the button not shown: Overleaf's PDF in view, or a layout without the toolbar; or something else of ours up: later)
    if (busy || !btn.isConnected || !btn.offsetParent) return void compareTip(btn);
    if (!document.getElementById("phitex-cmptip-css")) {
      const css = document.createElement("style");
      css.id = "phitex-cmptip-css";
      css.textContent = TIP_CSS;
      document.head.append(css);
    }
    const never = h("button", { type: "button", class: "btn btn-link btn-sm phitex-callout-never" }, "Don't show again");
    const no = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Not now");
    const yes = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "⇄ Try it");
    const c = callout({
      id: "phitex-cmptip",
      label: "Compare with a past version",
      anchor: btn,
      shiny: true,
      width: 330,
      header: [h("span", { class: "phitex-callout-icon", "aria-hidden": "true" }, "⇄"), "New: see what changed"],
      body: {
        html: `Compare this document with <b>any past version</b>: changes marked in the page, as <code>latexdiff</code> marks them, updated <b>as you type</b>.
        <div class="cmp-demo" aria-hidden="true">The results are <span class="del">good</span><span class="add">&nbsp;excellent</span>.<span class="ver"><i class="v0">Submitted v1</i><i class="v1">Now vs Submitted v1</i></span><span class="tag">‹ 1 / 1 ›</span></div>
        <div class="small text-muted" style="margin-top:6px">Pick a label or any point in the history. Download the diff PDF for your reviewers.</div>`,
      },
      actions: [never, no, yes],
    });
    yes.onclick = (e) => {
      e.stopPropagation();
      c.hide();
      btn.click();
    };
    no.onclick = () => {
      c.hide();
      void chrome.storage.local.set({ cmpTipNext: Date.now() + SNOOZE_MS });
    };
    never.onclick = () => {
      c.hide();
      void chrome.storage.local.set({ cmpTipOff: true });
    };
  }, TIP_DELAY_MS);
}

export function compareButton(host: HTMLElement, panel: Panel, base: () => string, fetcher: typeof fetch, run: DiffRunner): void {
  if (host.querySelector("#phitex-cmp")) return;
  const g = document.createElement("div");
  g.className = "dropdown btn-group";
  g.innerHTML =
    `<button type="button" id="phitex-cmp" aria-label="Compare with a past version" title="Compare with a past version (latexdiff)" aria-expanded="false" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link">` +
    `<span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">difference</span></span></button>` +
    `<ul class="dropdown-menu" id="phitex-cmpmenu" role="menu" style="max-height: 60vh; overflow-y: auto; min-width: 300px;"></ul>`;
  host.append(g);
  const btn = g.querySelector<HTMLButtonElement>("#phitex-cmp")!,
    menu = g.querySelector<HTMLElement>("#phitex-cmpmenu")!;
  let list: Version[] = [];
  let more: number | undefined;

  const item = (v: Version) =>
    `<li><button type="button" class="dropdown-item" data-v="${v.v}" style="display:flex;flex-direction:column;align-items:flex-start;gap:0;white-space:normal">` +
    `<span>${v.label ? "🏷 " : ""}${esc(v.title)}</span><span class="text-muted small">${ago(v.at)}${v.who.length ? ` · ${esc(v.who.join(", "))}` : ""} · v${v.v}</span></button></li>`;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const render = () => {
    const labels = list.filter((v) => v.label),
      ups = list.filter((v) => !v.label);
    menu.innerHTML =
      (controls.active ? `<li><button type="button" class="dropdown-item" data-stop="1">✕ Stop comparing</button></li><li><hr class="dropdown-divider"></li>` : "") +
      `<li><h6 class="dropdown-header">Compare the current version with…</h6></li>` +
      (labels.length ? `<li><h6 class="dropdown-header">Labels</h6></li>${labels.map(item).join("")}` : "") +
      `<li><h6 class="dropdown-header">History</h6></li>${ups.map(item).join("") || `<li><span class="dropdown-item-text text-muted small">No history yet</span></li>`}` +
      (more ? `<li><button type="button" class="dropdown-item text-muted" data-more="1">Older versions…</button></li>` : "");
  };
  const load = async (before?: number) => {
    const r = await versions(base(), fetcher, 30, before);
    list = before ? [...list, ...r.versions.filter((v) => !v.label)] : r.versions;
    more = r.more;
    render();
  };
  const close = () => {
    menu.classList.remove("show");
    btn.setAttribute("aria-expanded", "false");
  };

  btn.onclick = async (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains("show");
    if (!open) return close();
    menu.innerHTML = `<li><span class="dropdown-item-text text-muted small">Reading the project's history…</span></li>`;
    Object.assign(menu.style, { position: "absolute", inset: "100% auto auto 0" });
    menu.classList.add("show");
    btn.setAttribute("aria-expanded", "true");
    await load().catch((err) => (menu.innerHTML = `<li><span class="dropdown-item-text text-danger small">Couldn't read the history: ${esc(String(err.message ?? err))}</span></li>`));
  };
  menu.onclick = async (e) => {
    e.stopPropagation();
    const t = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!t) return;
    if (t.dataset.more) return void load(more).catch(() => undefined);
    close();
    if (t.dataset.stop) return stop();
    const v = list.find((x) => String(x.v) === t.dataset.v);
    if (v) void start(v);
  };
  document.addEventListener("click", close);
  // (the tip once the document has compiled, its first page drawn: not over a project still opening)
  let tipped = false;
  panel.onState((s) => {
    if (tipped || s.pages <= 0) return;
    tipped = true;
    compareTip(btn);
  });

  const controls = new DiffControls(panel, run);
  const start = async (v: Version) => {
    // (used: the tip never again)
    void chrome.storage.local.set({ cmpUsed: true });
    document.getElementById("phitex-cmptip")?.remove();
    await controls.start(v, v.title, `${ago(v.at)} · v${v.v}`);
  };
  const stop = () => controls.stop();
  // (keys while comparing: not in the editor or a field)
  addEventListener("keydown", (e) => controls.key(e));
}
