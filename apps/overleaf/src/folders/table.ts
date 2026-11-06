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
import { ago, h, icon } from "../dom.ts";
import { blankCell } from "./status.ts";
import { PAGE, pathChip, relPath, vocabulary, type View } from "./ui.ts";
import { marks, suggest, type Suggestion } from "./query.ts";
import { dashboard, ownerName } from "./overleaf.ts";

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
  const placeholder = placeholderOf(v);
  for (const theirs of document.querySelectorAll<HTMLElement>("#project-list-root .form-control-wrapper:has(> input.form-control:not(.olf-search-input))")) {
    let ours = theirs.previousElementSibling as HTMLElement | null;
    if (!ours?.classList.contains("olf-search")) {
      const input = h("input", { type: "text", class: "form-control-offset-start form-control olf-search-input", "aria-label": placeholder, autocomplete: "off", spellcheck: "false" });
      const mirror = h("div", { class: "olf-search-mirror", "aria-hidden": "true" });
      const help = h("button", { type: "button", class: "olf-search-help-btn", title: "Search syntax", "aria-label": "Search syntax" }, icon("help"));
      ours = h("div", { class: "form-control-wrapper olf-search" }, h("span", { class: "form-control-start-icon" }, icon("search")), input, mirror, help);
      suggestions(v, ours, input, mirror, help);
      theirs.before(ours);
    }
    const input = ours.querySelector<HTMLInputElement>("input")!;
    if (input.placeholder !== placeholder) (input.placeholder = placeholder), input.setAttribute("aria-label", placeholder);
    // (the text ours: kept, unless cleared here, as opening a folder does)
    if (input.value !== v.query && document.activeElement !== input) (input.value = v.query), input.dispatchEvent(new Event("olf-paint"));
  }
}

/** The box's line: where it searches, and the language by examples of the user's own (a tag, a folder of theirs). */
function placeholderOf(v: View): string {
  // (names of one word: a quoted one reads as code, not as an example)
  const word = (n?: string) => !!n && /^[\p{L}\p{N}_.-]+$/u.test(n);
  const tag = dashboard()?.tags?.map((t) => t.name).find(word);
  const folder = Object.values(v.state.folders).find((f) => f.parent === v.current && word(f.name))?.name;
  const tries = ["@me", `#${tag ?? "tag"}`, ...(folder ? [`in:${folder}`] : []), "after:2w"];
  const where = v.current ? `Search ${v.state.folders[v.current]?.name ?? "this folder"}` : "Find anything";
  return `${where}… try ${tries.join("  ")}`;
}

/** The language, each part with examples (taken into the box at a click), the search's help. */
const SYNTAX: [string, string, string[]][] = [
  ["words", "names, forgiving: a slip, letters skipped, a folder's name", ["reserch", "splt lerning"]],
  ["@name\nowner:", "who owns it; @me, your own", ["@me", "owner:me"]],
  ["#tag\ntag:", "an Overleaf tag", ["#thesis"]],
  ["in:", "under a folder (any depth); quotes keep spaces", ["in:Research", 'in:"Split Learning"']],
  ["status:", "the project's status", ["status:draft"]],
  ["after:\nbefore:", "last modified: a date, a month, a year, today, yesterday, or how long ago (7d 2w 6m 1y)", ["after:7d", "before:2026-09", "after:yesterday"]],
  ["is:", "yours, or shared with you", ["is:mine", "is:shared"]],
  ["-", "not this", ["-@me", "-#archive"]],
  ["a,b", "either one", ["#thesis,paper"]],
];

/** The search box's suggestions under it (query.ts's suggest), and its keys. */
function suggestions(v: View, box: HTMLElement, input: HTMLInputElement, mirror: HTMLElement, helpButton: HTMLElement) {
  let list: { start: number; end: number; items: Suggestion[] } = { start: 0, end: 0, items: [] };
  let active = -1;
  const menu = h("ul", { class: "dropdown-menu show olf-suggest", role: "listbox" });
  /** The list opened by ↓ (else only a filter's values open it: a word's suggestions are its ghost). */
  let forced = false;
  const close = () => {
    list.items = [];
    forced = false;
    menu.remove();
    paint();
  };
  /** The list's place: only for a filter being typed (the results are a word's suggestions), and not once the value is whole. */
  const listed = () => {
    const q = input.value;
    const typed = q.slice(list.start, list.end);
    // (nothing to choose: the value whole, or the one choice the ghost already shows)
    if (!list.items.length || (list.items.length === 1 && (list.items[0].insert === typed || (!forced && ghost())))) return false;
    return forced || marks(q).some((m) => m.start >= list.start && m.start < list.end);
  };
  /** The best suggestion's rest, after the caret at the end, grey (fish's way): Tab or → takes it. */
  const ghost = () => {
    const q = input.value;
    const top = list.items[Math.max(active, 0)];
    if (!top || input.selectionStart !== q.length || input.selectionEnd !== q.length || list.end !== q.length) return "";
    // (a quoted name's rest as typed, unquoted: taking it quotes it)
    const typed = q.slice(list.start, list.end).replace(/"/g, "");
    const plain = top.insert.replace(/"/g, "");
    return plain.length > typed.length && plain.toLowerCase().startsWith(typed.toLowerCase()) ? plain.slice(typed.length) : "";
  };
  // (the help: the language's parts, their examples; a click on one adds it to the query)
  const help = h("div", { class: "dropdown-menu show olf-search-help", role: "dialog", "aria-label": "Search syntax" },
    h("div", { class: "olf-search-help-head" }, "Search syntax", h("small", {}, "click an example to add it")),
    ...SYNTAX.map(([key, what, examples]) => h("div", { class: "olf-search-help-row" },
      h("code", { class: "olf-search-help-key" }, key),
      h("span", { class: "olf-search-help-what" }, what),
      h("span", { class: "olf-search-help-examples" }, ...examples.map((x) => {
        const b = h("button", { type: "button", class: "olf-search-help-example", tabindex: "-1" }, x);
        b.onmousedown = (e) => {
          e.preventDefault();
          const q = input.value.trimEnd();
          input.value = (q ? q + " " : "") + x + " ";
          input.setSelectionRange(input.value.length, input.value.length);
          input.focus();
          hideHelp();
          search(true);
          paint();
          refresh();
        };
        return b;
      })))),
    h("div", { class: "olf-search-help-foot" }, h("kbd", {}, "↑"), h("kbd", {}, "↓"), " choose a suggestion · ", h("kbd", {}, "Tab"), " take it · ", h("kbd", {}, "Esc"), " close, then clear"));
  const showHelp = () => {
    close();
    box.append(help);
    helpButton.classList.add("active");
  };
  const hideHelp = () => {
    help.remove();
    helpButton.classList.remove("active");
  };
  helpButton.onmousedown = (e) => {
    e.preventDefault();
    if (help.isConnected) hideHelp();
    else (input.focus(), showHelp());
  };
  const draw = () => {
    if (!listed() || document.activeElement !== input) return void menu.remove();
    hideHelp();
    const hint = h("button", { type: "button", class: "olf-suggest-hint", tabindex: "-1" }, h("span", {}, "↑↓ choose · Tab take"), h("span", { class: "olf-suggest-more" }, icon("help"), "Syntax"));
    hint.onmousedown = (e) => {
      e.preventDefault();
      showHelp();
    };
    menu.replaceChildren(
      ...list.items.slice(0, 6).map((s, i) => {
        const b = h("button", { type: "button", class: `dropdown-item${i === active ? " active" : ""}`, role: "option", tabindex: "-1" }, h("span", {}, s.label), ...(s.detail ? [h("small", {}, s.detail)] : []));
        // (taken on press: the box keeps the focus)
        b.onmousedown = (e) => {
          e.preventDefault();
          take(s);
        };
        return h("li", {}, b);
      }),
      h("li", {}, hint),
    );
    if (!menu.isConnected) box.append(menu);
  };
  // (the filters coloured as they are typed: the text drawn again under the box, the box's own
  // transparent over it, its caret and selection its own; scrolled as the box is)
  let painted = "";
  function paint() {
    const q = input.value;
    const rest = document.activeElement === input ? ghost() : "";
    if (q + "\0" + rest === painted) return void (mirror.scrollLeft = input.scrollLeft);
    painted = q + "\0" + rest;
    const ms = marks(q);
    box.classList.toggle("olf-marked", ms.length > 0 || !!rest);
    if (!ms.length && !rest) return mirror.replaceChildren();
    const parts: Node[] = [];
    let at = 0;
    for (const m of ms) {
      if (m.start > at) parts.push(document.createTextNode(q.slice(at, m.start)));
      parts.push(h("span", { class: `olf-q-${m.kind}` }, q.slice(m.start, m.end)));
      at = m.end;
    }
    parts.push(document.createTextNode(q.slice(at)), ...(rest ? [h("span", { class: "olf-q-ghost" }, rest)] : []), document.createTextNode("\u200b"));
    mirror.replaceChildren(...parts);
    mirror.scrollLeft = input.scrollLeft;
  }
  // (its metrics the box's, read once it is in the page)
  requestAnimationFrame(() => {
    const cs = getComputedStyle(input);
    for (const k of ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "borderLeftWidth", "borderRightWidth", "borderTopWidth", "borderBottomWidth", "font", "letterSpacing", "lineHeight"] as const) mirror.style[k] = cs[k];
  });
  input.addEventListener("olf-paint", paint);
  input.addEventListener("scroll", () => (mirror.scrollLeft = input.scrollLeft));
  const refresh = () => {
    // (nothing typed: no list over the projects; the placeholder says the language)
    list = input.value.trim() ? suggest(input.value, input.selectionStart ?? input.value.length, vocabulary(v)) : { start: 0, end: 0, items: [] };
    active = list.items.length ? 0 : -1;
    draw();
    paint();
  };
  // (the search once typing pauses: a key held or typed fast is one search, not one a key)
  let pending: ReturnType<typeof setTimeout> | undefined;
  const search = (now = false) => {
    clearTimeout(pending);
    if (now) v.search(input.value);
    else pending = setTimeout(() => v.search(input.value), 120);
  };
  const take = (s: Suggestion) => {
    const q = input.value;
    // (a filter's name: its value next, no space; a value: the next term after a space)
    const more = /[:@#,]$/.test(s.insert) ? "" : " ";
    const rest = q.slice(list.end).replace(/^\s*/, "");
    input.value = q.slice(0, list.start) + s.insert + more + rest;
    const at = list.start + s.insert.length + more.length;
    input.setSelectionRange(at, at);
    search(true);
    paint();
    refresh();
  };
  input.addEventListener("input", () => {
    forced = false;
    search();
    refresh();
  });
  input.addEventListener("focus", refresh);
  input.addEventListener("click", refresh);
  input.addEventListener("blur", () => setTimeout(() => (close(), hideHelp()), 100));
  input.addEventListener("keydown", (e) => {
    const open = list.items.length > 0 && menu.isConnected;
    const shown = Math.min(list.items.length, 6);
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown) % shown;
      draw();
      paint();
    } else if (!open && e.key === "ArrowDown" && list.items.length) {
      // (↓: the list, for a word's suggestions too)
      e.preventDefault();
      forced = true;
      draw();
    } else if (open && active >= 0 && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      take(list.items[active]);
    } else if ((e.key === "Tab" || e.key === "ArrowRight") && ghost()) {
      e.preventDefault();
      take(list.items[Math.max(active, 0)]);
    } else if (e.key === "Escape") {
      // (the suggestions or the help first; then the search)
      if (open) close();
      else if (help.isConnected) hideHelp();
      else (input.value = ""), search(true), paint();
    } else if (e.key === "?" && !input.value.trim()) {
      // (a "?" in an empty box: the help)
      e.preventDefault();
      showHelp();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") setTimeout(() => (refresh(), paint()));
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
