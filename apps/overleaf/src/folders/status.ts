// Each project's status (idea, drafting, ..., or the user's own) in a
// column of the project table, before "Owner": a badge, clicked for a menu
// to change it (the selected projects' all, if its row is one of them), to
// make a new status, or to manage them (as Overleaf's tags: rename,
// recolour, reorder, delete). The column's header
// sorts the table, by status or by (Overleaf's) tag, then by Overleaf's own
// order: React's rows put in that order, and back in its own when not.
// Drawn by ui.ts, as React adds rows.

import { readLocal, writeLocal } from "../common/format.ts";
import { invalidStatus, newId, statusesOf, type Status } from "./folders.ts";
import { colourPicker, COLOURS, dialog, h, icon, menu } from "../dom.ts";
import { dashboard, type Dashboard } from "./overleaf.ts";
import type { View } from "./ui.ts";

const SORT = "phitex:folders:sort";
/** Sorting the table by status (idea first) or by tag (A to Z), or reversed; null: Overleaf's own order. */
export type Sort = { by: "status" | "tag"; desc: boolean } | null;

/** (format 1: the sort, or null) */
export function loadSort(): Sort {
  const s = readLocal<Sort>(SORT, 1);
  return s?.by === "status" || s?.by === "tag" ? { by: s.by, desc: !!s.desc } : null;
}
export function saveSort(s: Sort) {
  writeLocal(SORT, 1, s);
}

/** Compares two projects by the sort (those with no status, or no tag, last either way); null when not sorting. */
export function sortCompare(v: View, d: Dashboard | null): ((a: string, b: string) => number) | null {
  const sort = v.sort;
  if (!sort) return null;
  const dir = sort.desc ? -1 : 1;
  let key: (id: string) => number | string | undefined;
  if (sort.by === "status") {
    const rank = new Map(statusesOf(v.state).map((x, i) => [x.id, i]));
    key = (id) => rank.get(v.state.status?.[id] ?? "");
  } else {
    // (a project's tags' names, in order: by its first, then its next)
    const names = new Map<string, string[]>();
    for (const t of d?.tags ?? []) for (const p of t.project_ids ?? []) names.set(p, [...(names.get(p) ?? []), t.name.toLowerCase()]);
    key = (id) => names.get(id)?.sort().join("\u0000");
  }
  return (a, b) => {
    const x = key(a), y = key(b);
    if (x === undefined || y === undefined) return (x === undefined ? 1 : 0) - (y === undefined ? 1 : 0);
    return dir * (typeof x === "number" ? x - (y as number) : (x as string).localeCompare(y as string, undefined, { numeric: true }));
  };
}

/** A project row's status cell (before its owner cell): made, or brought up to date. */
export function statusCell(v: View, tr: HTMLElement, id: string) {
  const status = statusesOf(v.state).find((x) => x.id === v.state.status?.[id]);
  const key = status ? `${status.id}:${status.name}:${status.color}` : "";
  let td = tr.querySelector<HTMLElement>(":scope > td.olf-status-cell");
  if (td?.dataset.s === key) return;
  if (!td) {
    td = h("td", { class: "olf-status-cell d-none d-md-table-cell" });
    const owner = tr.querySelector(":scope > td.dash-cell-owner");
    if (owner) owner.before(td);
    else tr.append(td);
  }
  td.dataset.s = key;
  td.replaceChildren(badge(v, status, id));
}

/** An empty status cell, for rows that aren't projects (folders, skeletons). */
export const blankCell = () => h("td", { class: "olf-status-cell d-none d-md-table-cell" });

function badge(v: View, status: Status | undefined, id: string): HTMLElement {
  const b = status
    ? h("button", { type: "button", class: "olf-status", style: `--c: ${status.color}`, title: "Change status" }, status.name)
    : h("button", { type: "button", class: "olf-status olf-status-empty", title: "Set a status" }, icon("add"), "status");
  b.onclick = (e) => {
    e.stopPropagation();
    // (the row selected: every selected project)
    const sel = dashboard()?.selectedProjectIds;
    const ids = sel?.has(id) ? [...sel] : [id];
    menu(b, [
      ...statusesOf(v.state).map((x): [Node, () => void] => [
        h("span", { class: `olf-status-item${x.id === status?.id ? " current" : ""}`, style: `--c: ${x.color}` }, x.name),
        () => v.setStatus(ids, x.id),
      ]),
      ["No status", status ? () => v.setStatus(ids, null) : null],
      "-",
      [h("span", { class: "olf-sort-item" }, icon("add"), "New status…"), () => newStatus(v, ids)],
      [h("span", { class: "olf-sort-item" }, icon("tune"), "Manage statuses…"), () => manageStatuses(v)],
    ]);
  };
  return b;
}

/** A status's name and colour, asked for (as Overleaf's tag dialog): null on cancel. */
async function askStatus(v: View, title: string, ok: string, initial: { name: string; color: string }, self?: string) {
  const picker = colourPicker(initial.color);
  const name = await dialog({ title, input: initial.name, extra: picker, ok, validate: (s) => invalidStatus(v.state, s, self) });
  return name === null ? null : { name, color: picker.value };
}

/** A new status; given to `ids` too (made from their badge). */
async function newStatus(v: View, ids: string[]) {
  const used = new Set(statusesOf(v.state).map((x) => x.color.toLowerCase()));
  const got = await askStatus(v, "New status", "Create", { name: "", color: COLOURS.find((c) => !used.has(c.toLowerCase())) ?? COLOURS[0] });
  if (!got) return;
  const id = newId();
  void v.change({ op: "addStatus", status: { id, ...got } }, { op: "status", projects: ids, status: id });
}

/** The statuses, as a list: each moved up or down (the order sorting follows), renamed, recoloured, or deleted. */
function manageStatuses(v: View) {
  const list = h("ul", { class: "list-unstyled olf-status-list" });
  const draw = () => {
    const all = statusesOf(v.state);
    const counts = new Map<string, number>();
    for (const x of Object.values(v.state.status ?? {})) counts.set(x, (counts.get(x) ?? 0) + 1);
    list.replaceChildren(...all.map((x, i) => {
      const button = (name: string, label: string, act: () => void, disabled = false) => {
        const b = h("button", { type: "button", class: "btn btn-link icon-button olf-icon-btn", title: label, "aria-label": `${label}: ${x.name}` }, icon(name));
        if (disabled) b.setAttribute("disabled", "");
        b.onclick = act;
        return b;
      };
      const n = counts.get(x.id) ?? 0;
      return h("li", {},
        button("arrow_upward", "Move up", () => void v.change({ op: "moveStatus", id: x.id, to: i - 1 }).then(draw), i === 0),
        button("arrow_downward", "Move down", () => void v.change({ op: "moveStatus", id: x.id, to: i + 1 }).then(draw), i === all.length - 1),
        h("span", { class: "olf-status-item olf-status-name", style: `--c: ${x.color}` }, x.name, h("span", { class: "olf-count" }, ` (${n})`)),
        button("edit", "Rename or recolour", async () => {
          const got = await askStatus(v, "Edit status", "Save", x, x.id);
          if (got) await v.change({ op: "editStatus", id: x.id, ...got });
          draw();
        }),
        button("delete", "Delete", async () => {
          const text = n ? `${n} project${n > 1 ? "s" : ""} with it will have no status.` : "No project has it.";
          if ((await dialog({ title: `Delete status "${x.name}"?`, text, ok: "Delete", danger: true })) !== null) await v.change({ op: "removeStatus", id: x.id });
          draw();
        }));
    }));
  };
  draw();
  const add = h("button", { type: "button", class: "btn btn-secondary olf-new-status" }, icon("add"), "New status");
  add.onclick = async () => {
    const used = new Set(statusesOf(v.state).map((x) => x.color.toLowerCase()));
    const got = await askStatus(v, "New status", "Create", { name: "", color: COLOURS.find((c) => !used.has(c.toLowerCase())) ?? COLOURS[0] });
    if (got) await v.change({ op: "addStatus", status: { id: newId(), ...got } });
    draw();
  };
  dialog({ title: "Statuses", text: "The table sorts by status in this order.", extra: h("div", {}, list, add), ok: "Done", cancel: false });
}

/**
 * The column's header, before "Owner": Overleaf's sort button's markup,
 * opening a menu (by status, by tag, Overleaf's order); what it sorts by,
 * and an arrow, when sorting.
 */
export function statusHeader(v: View) {
  const owner = document.querySelector("#project-list-root thead th.dash-cell-owner");
  if (!owner) return;
  let th = owner.parentElement!.querySelector<HTMLElement>(":scope > th.olf-status-col");
  if (!th) {
    th = h("th", { class: "olf-status-col d-none d-md-table-cell", "aria-label": "Status" });
    owner.before(th);
  }
  const key = JSON.stringify(v.sort);
  if (th.dataset.sort === key && th.firstChild) return;
  th.dataset.sort = key;
  th.setAttribute("aria-sort", !v.sort ? "none" : v.sort.desc ? "descending" : "ascending");
  const arrow = (desc: boolean) => icon(desc ? "arrow_downward_alt" : "arrow_upward_alt");
  const b = h("button", { type: "button", class: "table-header-sort-btn d-none d-md-inline-block", "aria-label": "Sort by status or tag" },
    h("span", {}, "Status"), ...(v.sort?.by === "tag" ? [h("span", { class: "olf-sort-by" }, "by tag")] : []), ...(v.sort ? [arrow(v.sort.desc)] : []));
  // (an item for the sort in use: the other way round)
  const item = (by: "status" | "tag", label: string): [Node, () => void] =>
    [h("span", { class: "olf-sort-item" }, label, v.sort?.by === by ? arrow(!v.sort.desc) : ""), () => v.sortBy(by)];
  b.onclick = () => menu(b, [item("status", "Sort by status"), item("tag", "Sort by tag"), ["Overleaf's order", v.sort ? () => v.sortBy(null) : null]]);
  th.replaceChildren(b);
}


