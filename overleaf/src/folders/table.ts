// The folders in the project table: the open folder's subfolders as rows on
// top, in a tbody of their own (React's, below, untouched), in the table's
// own cells; the path to the open folder over the table; a "New folder"
// button by "New project"; under the table, the folder's own "Show more".
// Skeleton rows stand in for what's not there yet: everything, until the
// folders are known; then the folder's projects still being rendered, below
// those that are (in a tbody after React's). Searching (our search box, in
// place of Overleaf's while browsing), the folders that match anywhere under
// the open one, each with its place. Drawn by ui.ts.

import { subtree, type Id } from "./folders.ts";
import { ago, h, icon } from "./dom.ts";
import { blankCell } from "./status.ts";
import { PAGE, pathChip, relPath, vocabulary, type View } from "./ui.ts";
import { suggest, type Suggestion } from "./query.ts";
import { ownerName } from "./overleaf.ts";

export function renderTable(v: View) {
  const table = document.querySelector("#project-list-root table.project-dash-table");
  const projects = table?.querySelector(":scope > tbody:not(.olf-rows)");
  if (!table || !projects) return;
  const body = table.querySelector<HTMLElement>(":scope > tbody.olf-rows") ?? h("tbody", { class: "olf-rows" });
  if (body.nextElementSibling !== projects) projects.before(body);
  const after = table.querySelector<HTMLElement>(":scope > tbody.olf-rows-after") ?? h("tbody", { class: "olf-rows olf-rows-after" });
  if (after.previousElementSibling !== projects) projects.after(after);
  const widths = [45, 30, 55, 38, 50];
  if (!v.ready) {
    body.replaceChildren(...widths.map((w) => skeletonRow(w, v.status)));
    after.replaceChildren();
    return;
  }
  after.replaceChildren(...(v.page.loading ? widths.slice(0, Math.min(v.page.missing, widths.length)).map((w) => skeletonRow(w, v.status)) : []));
  if (v.found) {
    const rows = v.found.folders.map(({ id }) => folderRow(v, id, v.state.folders[id].name));
    if (!rows.length && !v.found.projects.size) rows.push(h("tr", { class: "olf-empty" }, h("td", { colspan: "8" }, `Nothing ${v.current ? "in this folder " : ""}matches “${v.query.trim()}”.`)));
    body.replaceChildren(...rows);
  } else {
    const children = Object.entries(v.state.folders)
      .filter(([, f]) => f.parent === v.current)
      .sort(([, a], [, b]) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    const rows = children.map(([id, f]) => folderRow(v, id, f.name));
    if (v.current && !rows.length && !v.page.total)
      rows.push(h("tr", { class: "olf-empty", "data-drop": v.current }, h("td", { colspan: "8" }, "This folder is empty. Drag projects here.")));
    body.replaceChildren(...rows);
  }
  searchBox(v);
  crumbs(v);
  newFolderButton(v);
  footer(v, table);
}

/** A row of grey bars, as the table's (name, owner, date). */
function skeletonRow(width: number, status: boolean): HTMLElement {
  const bar = (w: number) => h("span", { class: "olf-bar", style: `width: ${w}%` });
  return h("tr", { class: "olf-skeleton", "aria-hidden": "true" },
    h("td", { class: "dash-cell-checkbox d-none d-md-table-cell" }),
    h("td", { class: "dash-cell-name" }, bar(width)),
    h("td", { class: "dash-cell-date-owner pb-0 d-md-none" }, bar(40)),
    // (the Status column's cell, only with the column: else its columns shift, the date's squeezed out)
    ...(status ? [blankCell()] : []),
    h("td", { class: "dash-cell-owner d-none d-md-table-cell" }, bar(50)),
    h("td", { class: "dash-cell-date d-none d-md-table-cell" }, bar(60)),
    h("td", { class: "dash-cell-tag pt-0 d-md-none" }),
    h("td", { class: "dash-cell-actions" }));
}

/** "Showing 20 out of 134 projects", "Show 20 more": the open folder's, in Overleaf's footer's markup (load-more.tsx). */
function footer(v: View, table: Element) {
  const el = document.querySelector<HTMLElement>(".olf-footer") ?? h("div", { class: "text-center olf-footer" });
  const anchor = document.querySelector("#project-list-root div.text-center:has(> p):not(.olf-footer)") ?? table;
  if (anchor.nextElementSibling !== el) anchor.after(el);
  const { shown, total, loading } = v.page;
  const hidden = total - shown;
  const kids: Node[] = [];
  if (hidden > 0 && !loading) {
    const more = h("button", { type: "button", class: "btn btn-secondary project-list-load-more-button" }, `Show ${Math.min(hidden, PAGE)} more projects`);
    more.onclick = () => v.more();
    kids.push(more);
  }
  const line = h("p", {}, h("span", { "aria-live": "polite" }, loading ? h("span", { class: "spinner-border", role: "status" }) : "", loading ? "Loading projects…" : `Showing ${shown} out of ${total} projects.`));
  if (hidden > 0 && !loading) {
    const all = h("button", { type: "button", class: "btn btn-link btn-inline-link" }, "Show all projects");
    all.onclick = () => v.all();
    line.append(" ", all);
  }
  kids.push(line);
  el.replaceChildren(...kids);
}

function folderRow(v: View, id: Id, name: string): HTMLElement {
  // (its date and count: of the projects anywhere under it)
  const under = subtree(v.state, id);
  let latest = "";
  let count = 0;
  const owners = new Map<string, number>();
  for (const [p, f] of Object.entries(v.state.projects)) {
    const project = v.projects.get(p);
    if (!under.has(f) || !project) continue;
    count++;
    if (project.lastUpdated > latest) latest = project.lastUpdated;
    const who = ownerName(project);
    owners.set(who, (owners.get(who) ?? 0) + 1);
  }
  // (its icon where a project's checkbox is: the names in line; on a phone, no such column, before the name)
  const link = h("a", { href: `#folder=${id}`, class: "olf-folder-link", translate: "no" }, icon("folder", "d-md-none"), name);
  link.onclick = (e) => {
    e.preventDefault();
    v.open(id);
  };
  const when = latest ? ago(latest) : "";
  const tr = h("tr", { class: "olf-folder-row", "data-folder": id, "data-drop": id, draggable: "true" },
    h("td", { class: "dash-cell-checkbox d-none d-md-table-cell olf-folder-icon" }, icon("folder")),
    h("td", { class: "dash-cell-name" }, link, " ", h("span", { class: "olf-count", title: count === 1 ? "1 project" : `${count} projects` }, `(${count})`),
      // (a search's result: where it is under the open folder)
      ...(v.found && v.state.folders[id].parent && v.state.folders[id].parent !== v.current ? [pathChip(v, v.state.folders[id].parent!, relPath(v, v.state.folders[id].parent!))] : [])),
    h("td", { class: "dash-cell-date-owner pb-0 d-md-none" }, when),
    ...(v.status ? [blankCell()] : []),
    ownerCell(owners),
    h("td", { class: "dash-cell-date d-none d-md-table-cell" }, when),
    h("td", { class: "dash-cell-tag pt-0 d-md-none" }),
    h("td", { class: "dash-cell-actions" }, h("div", {}, h("div", { class: "d-none d-lg-block" },
      action("drive_file_rename_outline", "Rename folder", () => v.rename(id)),
      action("create_new_folder", "New folder inside", () => v.create(id)),
      action("folder_delete", "Delete folder", () => v.remove(id))))));
  tr.ondblclick = (e) => {
    if (!(e.target as Element).closest("a, button")) v.open(id);
  };
  return tr;
}

/** The owners of a folder's projects: "You", "You, Mohamed Bouaziz", "You, Mohamed +3"; all of them, with counts, on hover. */
function ownerCell(owners: Map<string, number>): HTMLElement {
  // (you first, then by how many projects each owns)
  const all = [...owners].sort(([a, m], [b, n]) => (a === "You" ? -1 : b === "You" ? 1 : n - m || a.localeCompare(b)));
  // (more than two: the first two, first names only, and how many more)
  const many = all.length > 2;
  const text = all.slice(0, 2).map(([w]) => (many && w !== "You" ? w.split(" ")[0] : w)).join(", ") + (many ? ` +${all.length - 2}` : "");
  const title = all.map(([w, n]) => `${w}: ${n} project${n === 1 ? "" : "s"}`).join("\n");
  return h("td", { class: "dash-cell-owner d-none d-md-table-cell", ...(all.length ? { title } : {}) }, text);
}

/**
 * Our search box, in place of Overleaf's while browsing (its own filters
 * by exact substring; ours forgives, finds folders, and has filters:
 * query.ts): each of Overleaf's boxes (a wide layout's, a narrow one's)
 * gets one of ours before it, in its markup, shown instead of it while
 * browsing. As you type, what fits where the caret is is suggested under
 * it (filters, then their values); ↑ ↓ choose, Tab or Enter takes one.
 */
function searchBox(v: View) {
  const placeholder = v.current ? `Search in ${v.state.folders[v.current]?.name ?? "this folder"}…` : "Search in all projects…";
  for (const theirs of document.querySelectorAll<HTMLElement>("#project-list-root .form-control-wrapper:has(> input.form-control:not(.olf-search-input))")) {
    let ours = theirs.previousElementSibling as HTMLElement | null;
    if (!ours?.classList.contains("olf-search")) {
      const input = h("input", { type: "text", class: "form-control-offset-start form-control olf-search-input", "aria-label": placeholder, autocomplete: "off", spellcheck: "false" });
      ours = h("div", { class: "form-control-wrapper olf-search" }, h("span", { class: "form-control-start-icon" }, icon("search")), input);
      suggestions(v, ours, input);
      theirs.before(ours);
    }
    const input = ours.querySelector<HTMLInputElement>("input")!;
    if (input.placeholder !== placeholder) (input.placeholder = placeholder), input.setAttribute("aria-label", placeholder);
    // (the text ours: kept, unless cleared here, as opening a folder does)
    if (input.value !== v.query && document.activeElement !== input) input.value = v.query;
  }
}

/** The search box's suggestions under it (query.ts's suggest), and its keys. */
function suggestions(v: View, box: HTMLElement, input: HTMLInputElement) {
  let list: { start: number; end: number; items: Suggestion[] } = { start: 0, end: 0, items: [] };
  let active = -1;
  const menu = h("ul", { class: "dropdown-menu show olf-suggest", role: "listbox" });
  const close = () => {
    list.items = [];
    menu.remove();
  };
  const draw = () => {
    if (!list.items.length || document.activeElement !== input) return close();
    menu.replaceChildren(
      ...(input.value.trim() ? [] : [h("li", { class: "olf-suggest-hint" }, "Words find names, forgivingly; filters narrow:")]),
      ...list.items.map((s, i) => {
        const b = h("button", { type: "button", class: `dropdown-item${i === active ? " active" : ""}`, role: "option", tabindex: "-1" }, h("span", {}, s.label), ...(s.detail ? [h("small", {}, s.detail)] : []));
        // (taken on press: the box keeps the focus)
        b.onmousedown = (e) => {
          e.preventDefault();
          take(s);
        };
        return h("li", {}, b);
      }),
    );
    if (!menu.isConnected) box.append(menu);
  };
  const refresh = () => {
    list = suggest(input.value, input.selectionStart ?? input.value.length, vocabulary(v));
    active = list.items.length && input.value.trim() ? 0 : -1;
    draw();
  };
  const take = (s: Suggestion) => {
    const q = input.value;
    // (a filter's name: its value next, no space; a value: the next term after a space)
    const more = /[:@#,]$/.test(s.insert) ? "" : " ";
    const rest = q.slice(list.end).replace(/^\s*/, "");
    input.value = q.slice(0, list.start) + s.insert + more + rest;
    const at = list.start + s.insert.length + more.length;
    input.setSelectionRange(at, at);
    v.search(input.value);
    refresh();
  };
  input.addEventListener("input", () => {
    v.search(input.value);
    refresh();
  });
  input.addEventListener("focus", refresh);
  input.addEventListener("click", refresh);
  input.addEventListener("blur", () => setTimeout(close, 100));
  input.addEventListener("keydown", (e) => {
    const open = list.items.length > 0 && menu.isConnected;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + list.items.length) % list.items.length;
      draw();
    } else if (open && active >= 0 && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      take(list.items[active]);
    } else if (e.key === "Escape") {
      // (the suggestions first; then the search)
      if (open) close();
      else (input.value = ""), v.search("");
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") setTimeout(refresh);
  });
}

/** An icon button as the table's own (Copy, Download, ...). */
function action(name: string, label: string, act: () => void): HTMLElement {
  const b = h("button", { type: "button", class: "d-inline-grid action-btn icon-button btn btn-link", "aria-label": label, title: label },
    h("span", { class: "button-content" }, icon(name, "icon-small")));
  b.onclick = () => act();
  return h("span", {}, b);
}

/** "All projects › Research › PhD", each a link and a drop target, over the table. */
function crumbs(v: View) {
  const heading = document.querySelector("#project-list-root h1.project-list-title:not(.olf-crumbs)");
  if (!heading) return;
  const nav = document.querySelector<HTMLElement>(".olf-crumbs") ?? h("h1", { class: "project-list-title olf-crumbs" });
  // (after Overleaf's heading, which stays its row's first child: its margins are a first child's)
  if (nav.previousElementSibling !== heading) heading.after(nav);
  const chain: Id[] = [];
  for (let f = v.current; f && v.state.folders[f]; f = v.state.folders[f].parent) chain.unshift(f);
  const link = (id: Id | null, label: string) => {
    const a = h("a", { href: id ? `#folder=${id}` : "/project", "data-drop": id ?? "", translate: "no" }, label);
    a.onclick = (e) => {
      e.preventDefault();
      v.open(id);
    };
    return a;
  };
  const items: Node[] = [link(null, "All projects")];
  chain.forEach((id, i) => {
    const name = v.state.folders[id].name;
    items.push(icon("chevron_right", "olf-sep"), i === chain.length - 1 ? h("span", { "data-drop": id, translate: "no" }, name) : link(id, name));
  });
  nav.replaceChildren(...items);
}

function newFolderButton(v: View) {
  const dropdown = document.querySelector("#project-list-root .new-project-dropdown");
  if (!dropdown || dropdown.parentElement!.querySelector(":scope > .olf-new-folder")) return;
  const b = h("button", { type: "button", class: "btn btn-secondary olf-new-folder" }, icon("create_new_folder"), "New folder");
  b.onclick = () => v.create(v.current);
  dropdown.before(b);
}
