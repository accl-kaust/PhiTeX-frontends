// The folder tree in the dashboard's sidebar, below Overleaf's tags, in its
// classes (.tag, .tag-name): a way to any folder, and a drop target for
// all. Drawn by ui.ts.

import { pathOf, tree, type Folder } from "./folders.ts";
import { h, icon, menu } from "../dom.ts";
import type { View } from "./ui.ts";

const COLLAPSED = "phitex:folders:collapsed";

export function renderSidebar(v: View) {
  const native = document.querySelector("#project-list-root .project-list-filters:not(.olf-folders)");
  if (!native) return;
  const ul = document.querySelector<HTMLElement>(".olf-folders") ?? h("ul", { class: "list-unstyled project-list-filters olf-folders" });
  if (native.nextElementSibling !== ul) native.after(ul);
  const header = h("li", { class: "dropdown-header", "data-drop": "" }, "Folders");
  if (v.error) return ul.replaceChildren(header, h("li", { class: "olf-note" }, v.error));
  const collapsed = loadCollapsed();
  // (the open folder's ancestors: open)
  for (let f = v.current; f && v.state.folders[f]; f = v.state.folders[f].parent) if (f !== v.current) collapsed.delete(f);
  const rows: HTMLElement[] = [];
  const walk = (fs: Folder[], depth: number) => {
    for (const f of fs) {
      rows.push(folderRow(v, f, depth, collapsed));
      if (!collapsed.has(f.id)) walk(f.children, depth + 1);
    }
  };
  walk(tree(v.state, new Set(v.projects.keys())), 0);
  const newFolder = h("button", { type: "button", class: "tag-name" }, icon("create_new_folder", "olf-icon"), h("span", { class: "name" }, "New folder"));
  newFolder.onclick = () => v.create(v.browsing ? v.current : null);
  ul.replaceChildren(header, ...rows, h("li", { class: "tag" }, newFolder));
}

function folderRow(v: View, f: Folder, depth: number, collapsed: Set<string>): HTMLElement {
  const open = !collapsed.has(f.id);
  const twisty = h("span", { class: "olf-twisty" }, f.children.length ? icon(open ? "expand_more" : "chevron_right") : "");
  twisty.onclick = (e) => {
    e.stopPropagation();
    if (open) collapsed.add(f.id);
    else collapsed.delete(f.id);
    saveCollapsed(collapsed);
    renderSidebar(v);
  };
  const name = h("button", { type: "button", class: "tag-name", translate: "no", draggable: "true", title: pathOf(v.state, f.id) },
    twisty, icon(f.children.length && open ? "folder_open" : "folder", "olf-icon"),
    h("span", { class: "name" }, f.name, " ", h("span", { class: "subdued" }, `(${f.projects.length})`)));
  name.onclick = () => v.open(f.id);
  const more = h("button", { type: "button", class: "dropdown-toggle btn btn-primary", "aria-label": `Open ${f.name} folder menu` }, icon("more_vert"));
  more.onclick = (e) => {
    e.stopPropagation();
    menu(more, [
      ["New folder inside", () => v.create(f.id)],
      ["Rename", () => v.rename(f.id)],
      ["Move to top level", v.state.folders[f.id].parent ? () => void v.change({ op: "move", id: f.id, parent: null }) : null],
      ["Delete", () => v.remove(f.id)],
    ]);
  };
  const li = h("li", { class: `tag olf-folder${v.browsing && v.current === f.id ? " active" : ""}`, "data-folder": f.id, "data-drop": f.id },
    name, h("div", { class: "tag-menu dropdown" }, more));
  li.style.setProperty("--olf-depth", String(depth));
  return li;
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED) ?? "[]"));
  } catch {
    return new Set();
  }
}
function saveCollapsed(s: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED, JSON.stringify([...s]));
  } catch {}
}
