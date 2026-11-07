// Compare with a past version: the toolbar's Compare button (beside the
// download, Overleaf's own dropdown markup), its menu of versions (the
// labels, then the history, older on demand: history.ts); its tip is the
// panel's own (the animated "compare" feature tip). The diff bar over the page, its state and keys, are
// common/src/compare.ts's DiffControls; what a diff is made of (the
// phitex-diff markup, typeset) is the runner's: `start` gets the version
// picked.

import type { Panel } from "./common/viewer/panel.ts";
import { DiffControls, type DiffRunner as Runner } from "./common/viewer/compare.ts";
import { type Version, versions } from "./history.ts";
import { ago, html } from "./dom.ts";

export type DiffRunner = Runner<Version>;

export function compareButton(host: HTMLElement, panel: Panel, base: () => string, fetcher: typeof fetch, run: DiffRunner): void {
  if (host.querySelector("#phitex-cmp")) return;
  const g = document.createElement("div");
  g.className = "dropdown btn-group";
  g.replaceChildren(html`<button type="button" id="phitex-cmp" aria-label="Compare with a past version" title="Compare with a past version (latexdiff)" aria-expanded="false" class="d-inline-grid pdf-toolbar-btn toolbar-item btn btn-link"><span class="button-content" aria-hidden="false"><span class="material-symbols" aria-hidden="true" translate="no">difference</span></span></button><ul class="dropdown-menu" id="phitex-cmpmenu" role="menu" style="max-height: 60vh; overflow-y: auto; min-width: 300px;"></ul>`);
  host.append(g);
  const btn = g.querySelector<HTMLButtonElement>("#phitex-cmp")!,
    menu = g.querySelector<HTMLElement>("#phitex-cmpmenu")!;
  let list: Version[] = [];
  let more: number | undefined;

  const item = (v: Version) =>
    html`<li><button type="button" class="dropdown-item" data-v="${v.v}" style="display:flex;flex-direction:column;align-items:flex-start;gap:0;white-space:normal"><span>${v.label ? "🏷 " : ""}${v.title}</span><span class="text-muted small">${ago(v.at)}${v.who.length ? ` · ${v.who.join(", ")}` : ""} · v${v.v}</span></button></li>`;
  const render = () => {
    const labels = list.filter((v) => v.label),
      ups = list.filter((v) => !v.label);
    menu.replaceChildren(
      controls.active ? html`<li><button type="button" class="dropdown-item" data-stop="1">✕ Stop comparing</button></li><li><hr class="dropdown-divider"></li>` : "",
      html`<li><h6 class="dropdown-header">Compare the current version with…</h6></li>`,
      labels.length ? html`<li><h6 class="dropdown-header">Labels</h6></li>${labels.map(item)}` : "",
      html`<li><h6 class="dropdown-header">History</h6></li>${ups.length ? ups.map(item) : html`<li><span class="dropdown-item-text text-muted small">No history yet</span></li>`}`,
      more ? html`<li><button type="button" class="dropdown-item text-muted" data-more="1">Older versions…</button></li>` : "",
    );
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
    await load().catch((err) => menu.replaceChildren(html`<li><span class="dropdown-item-text text-danger small">Couldn't read the history: ${String(err.message ?? err)}</span></li>`));
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
  const controls = new DiffControls(panel, run);
  const start = async (v: Version) => {
    await controls.start(v, v.title, `${ago(v.at)} · v${v.v}`);
  };
  const stop = () => controls.stop();
  // (keys while comparing: not in the editor or a field)
  addEventListener("keydown", (e) => controls.key(e));
}
