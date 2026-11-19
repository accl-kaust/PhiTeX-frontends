// Changes in Overleaf's PDF toolbar: one ± Changes button (Overleaf's own
// toolbar markup) beside the download, in place of Compare's and Blame's
// two; the popover under it is the viewer's (changes.ts), Diff and Blame as
// one, its history Overleaf's (blame.ts, olhistory.ts). Hovering it peeks,
// a click keeps it on.

import type { Panel } from "./common/viewer/panel.ts";
import { CHANGES_BUTTON_CSS } from "./common/viewer/changes.ts";
import { html } from "./dom.ts";

export function changesButton(host: HTMLElement, panel: Panel): void {
  if (host.querySelector("#phitex-changes") || !panel.changes) return;
  if (!document.getElementById("phitex-changes-css")) {
    const st = document.createElement("style");
    st.id = "phitex-changes-css";
    st.textContent = `${CHANGES_BUTTON_CSS}
#phitex-changes { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
#phitex-changes .chg-glyph { font: 600 15px ui-monospace, monospace; line-height: 1; }
#phitex-changes.on { background: var(--toolbar-btn-hover-bg-color, rgba(127,127,127,.18)); }`;
    document.head.append(st);
  }
  const g = document.createElement("div");
  g.className = "btn-group";
  g.replaceChildren(html`<button type="button" id="phitex-changes" aria-label="Changes" title="Changes: what changed between two versions, and who wrote what (hover to peek, click to keep on)" aria-pressed="false" class="pdf-toolbar-btn toolbar-item btn btn-link"><span class="chg-glyph" aria-hidden="true">±</span><span class="button-content">Changes</span><span class="chg-badge" id="phitex-changes-n"></span></button>`);
  host.append(g);
  panel.changes.attach(g.querySelector<HTMLElement>("#phitex-changes")!, g.querySelector<HTMLElement>("#phitex-changes-n")!);
}
