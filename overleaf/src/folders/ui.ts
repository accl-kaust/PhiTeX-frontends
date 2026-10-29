// The folders on Overleaf's project dashboard, as in a file manager. On its
// "All projects" (no tag, no search: browsing), the table shows the open
// folder's subfolders (table.ts), then its projects, a page at a time; at
// the top level, the projects in no folder. A tree in the sidebar
// (sidebar.ts) and a path over the table lead anywhere. Rows are dragged
// onto folders: projects (the selected ones, if the dragged one is among
// them) and folders alike.
//
// Overleaf has every project from the page's start, and renders its list's
// first n (20, then 20 more, or all): rows of another folder's are marked
// hidden as React adds them, before they're painted (React rendering them
// untouched), and n raised until the open folder's page is all rendered. So
// Overleaf's "select all" is narrowed here to the rows shown, and changing
// folders clears the selection, lest a bulk action reach projects out of
// sight.
//
// The last folders seen are kept in the browser, so they're drawn at once,
// from the page's start, while the stored ones are read; with none kept yet,
// skeleton rows stand in.

import { canMove, invalid, newId, pathOf, statusesOf, subtree, type Id, type Op, type State } from "./folders.ts";
import { fuzzy, occurrences, type Match } from "./fuzzy.ts";
import { matches, parse, type Item, type Query, type Vocabulary } from "./query.ts";
import { dialog, h, icon } from "./dom.ts";
import { dashboard, listProjects, ownerName, projectsOnPage, watch, type Dashboard, type Project } from "./overleaf.ts";
import { isStorageName, projectStorage } from "./project.ts";
import { renderSidebar } from "./sidebar.ts";
import { loadSort, saveSort, sortCompare, statusCell, statusHeader, type Sort } from "./status.ts";
import { Folders, type Storage } from "./sync.ts";
import { renderTable } from "./table.ts";

const MOUNTED = "data-olf-mounted";
const CACHE = "phitex:folders:state";
export const PAGE = 20;
/** The table's own rows (React's), not the folders'. */
const PROJECT_ROWS = "#project-list-root table > tbody:not(.olf-rows) > tr";
/** Rows React has drawn (of its visibleProjects). */
let drawn = 0;

export type MountOptions = {
  /** Where the folders are kept: by default the user's ".phitex-data" project (project.ts), made at the first change. */
  storage?: Storage & { find?(): Promise<string | null> };
  /** Asked before the first change while the storage has no project: true, the user agrees to its being made. */
  ask?: () => Promise<boolean>;
  /** The Status column (status.ts): shown, and the table sortable by status or tag. */
  status?: boolean;
  /** The storage project left out of the project list (else listed as any project). */
  hideStorage?: boolean;
  /** Called after each drawing (a tip pointing at what's drawn: main.ts). */
  drawn?: (v: View) => void;
};

/** What the views (table.ts, sidebar.ts) draw and act through. */
export type View = {
  folders: Folders;
  /** Makes a change (folders.do), once the user agrees to the storage project if there's none yet (MountOptions.ask); resolves once made, or not. */
  change(...ops: Op[]): Promise<void>;
  /** The storage project there, or the user agreeing to it now (asked once: MountOptions.ask). */
  agree(): Promise<boolean>;
  state: State;
  /** Folders and projects known: drawn (else skeleton rows). */
  ready: boolean;
  /** The storage project is there, or agreed to (changes are made without asking). */
  stored: boolean;
  /** The Status column shown (MountOptions.status): the folders' rows have its cell. */
  status: boolean;
  /** The search box's text (ours, in place of Overleaf's while browsing: forgiving, folders too). */
  query: string;
  /** While searching: what matches under the open folder, projects by id and folders, best first. */
  found: { query: Query; projects: Map<string, Match>; folders: { id: Id; match: Match }[] } | null;
  search(q: string): void;
  /** Overleaf's "All projects", no tag, no search: the folders shown in the table. */
  browsing: boolean;
  /** The folder open; null: the top level. */
  current: Id | null;
  /** The user's projects, not archived or trashed (nor the storage's, if hidden). */
  projects: Map<string, Project>;
  /** Sorting the table by status or tag (else Overleaf's order). */
  sort: Sort;
  /** The open folder's projects: how many shown, of how many; how many more of its page being rendered. */
  page: { shown: number; total: number; loading: boolean; missing: number };
  error: string;
  open(id: Id | null): void;
  more(): void;
  all(): void;
  create(parent: Id | null): void;
  rename(id: Id): void;
  remove(id: Id): void;
  setStatus(projects: string[], status: Id | null): void;
  /** Sorts by status or tag (by the one in use: the other way round); null: Overleaf's order. */
  sortBy(by: "status" | "tag" | null): void;
};

/** Shows the folders on the dashboard (from the page's start on: it waits for the dashboard); returns the unmount. */
export function mount(opts: MountOptions = {}): () => void {
  const root = document.documentElement;
  // (one per page: the standalone extension and one embedding this, both installed)
  if (root.hasAttribute(MOUNTED)) return () => {};
  root.setAttribute(MOUNTED, "");
  const storage = opts.storage ?? projectStorage();
  const cached = readCache();
  const folders = new Folders(storage, 400, cached);
  addStyle();
  /** The stored folders read (not only the kept copy). */
  let loaded = false;
  let storageProject: string | undefined;
  let limit = PAGE;
  /** Times Overleaf's been asked to render 20 more, for the page shown. */
  let steps = 0;
  /** The open folder's projects, and how many of them React has rendered. */
  let inView = new Set<string>();
  let rendered = 0;
  /** The user agreed to the storage project being made (asked once: MountOptions.ask). */
  let agreed = false;
  let asking: Promise<boolean> | null = null;

  const v: View = {
    folders,
    async agree() {
      if (!opts.ask || storageProject || agreed) return true;
      agreed = await (asking ??= opts.ask().finally(() => (asking = null)));
      update();
      return agreed;
    },
    async change(...ops) {
      // (synchronous once agreed, or with the project there: a change shows at once)
      if (opts.ask && !storageProject && !agreed && !(await v.agree())) return;
      folders.do(...ops);
    },
    state: folders.state,
    ready: false,
    stored: false,
    status: !!opts.status,
    query: "",
    found: null,
    search(q) {
      v.query = q;
      limit = PAGE;
      steps = 0;
      update();
    },
    browsing: false,
    current: fromHash(),
    projects: new Map(),
    sort: opts.status ? loadSort() : null,
    page: { shown: 0, total: 0, loading: false, missing: 0 },
    error: "",
    open(id) {
      const d = dashboard();
      // (Overleaf's "All projects", which also clears its selection; else cleared here)
      if (d && (d.filter !== "all" || d.selectedTagId)) d.selectFilter("all");
      else d?.setSelectedProjectIds(new Set());
      v.current = id;
      // (a folder opened, from a search's results too: browsed, the search done)
      v.query = "";
      limit = PAGE;
      steps = 0;
      history.pushState(null, "", id ? `/project#folder=${id}` : "/project");
      update();
    },
    more() {
      limit += PAGE;
      steps = 0;
      update();
    },
    all() {
      limit = Infinity;
      steps = 0;
      update();
    },
    setStatus(projects, status) {
      void v.change({ op: "status", projects, status });
    },
    sortBy(by) {
      v.sort = by === null ? null : { by, desc: v.sort?.by === by ? !v.sort.desc : false };
      saveSort(v.sort);
      update();
    },
    async create(parent) {
      // (the terms first, then the folder's name)
      if (!(await v.agree())) return;
      const name = await dialog({ title: parent ? `New folder in ${pathOf(v.state, parent)}` : "New folder", input: "", ok: "Create", validate: (s) => invalid(v.state, parent, s) });
      if (name !== null) await v.change({ op: "create", id: newId(), parent, name });
    },
    async rename(id) {
      const f = v.state.folders[id];
      const name = await dialog({ title: "Rename folder", input: f.name, ok: "Rename", validate: (s) => invalid(v.state, f.parent, s, id) });
      if (name !== null && name !== f.name) await v.change({ op: "rename", id, name });
    },
    async remove(id) {
      const sub = subtree(v.state, id).size - 1;
      const where = v.state.folders[id].parent ? `"${v.state.folders[v.state.folders[id].parent!].name}"` : "the top level";
      const text = `Its projects${sub ? `, and those of the ${sub} folder${sub > 1 ? "s" : ""} inside it,` : ""} are kept: they move to ${where}.`;
      if ((await dialog({ title: `Delete folder "${v.state.folders[id].name}"?`, text, ok: "Delete", danger: true })) === null) return;
      // (a folder deleted: its projects move up to its parent, as in a file manager)
      const parent = v.state.folders[id].parent;
      const inside = Object.keys(v.state.projects).filter((p) => subtree(v.state, id).has(v.state.projects[p]));
      await v.change({ op: "delete", id }, ...(parent && inside.length ? [{ op: "file" as const, projects: inside, folder: parent }] : []));
    },
  };

  const setProjects = (projects: Project[]) => {
    // (the storage's own: the default one's found by name at once, before it's asked for)
    if (!opts.storage) storageProject ??= projects.find((p) => isStorageName(p.name) && p.accessLevel === "owner" && !p.trashed)?.id;
    v.projects = new Map(projects.filter((p) => !p.archived && !p.trashed && !(opts.hideStorage && p.id === storageProject)).map((p) => [p.id, p]));
  };
  const browsing = (d: Dashboard | null) => v.ready && !!d && d.filter === "all" && !d.selectedTagId && !d.searchText.trim();

  /**
   * Puts the project rows in order (by status, if sorting; else Overleaf's),
   * gives them their status cells, and marks each shown or hidden
   * (`data-olf`): as React adds them, before they're painted.
   */
  function mark() {
    const d = dashboard();
    const on = browsing(d);
    const rows = [...document.querySelectorAll<HTMLElement>(PROJECT_ROWS)];
    drawn = rows.length;
    const at = new Map(d?.visibleProjects.map((p, i) => [p.id, i]));
    const items = rows.map((tr, i) => {
      const id = tr.querySelector("[data-project-id]")?.getAttribute("data-project-id") ?? tr.querySelector<HTMLAnchorElement>("a[href^='/project/']")?.pathname.split("/")[2];
      return { tr, id, at: id && at.has(id) ? at.get(id)! : 1e9 + i };
    });
    // (searching: the best matches first; else by status, if sorting; else Overleaf's order)
    const found = v.found?.projects;
    const cmp = found ? (a: string, b: string) => (found.get(b)?.score ?? 0) - (found.get(a)?.score ?? 0) : sortCompare(v, d);
    items.sort((a, b) => (cmp && a.id && b.id ? cmp(a.id, b.id) : 0) || a.at - b.at);
    // (moved only when out of order: moving them is a change too, seen here again)
    if (items.some((x, i) => x.tr !== rows[i])) for (const x of items) x.tr.parentElement!.append(x.tr);
    let n = 0;
    for (const { tr, id } of items) {
      const as = opts.hideStorage && id === storageProject ? "hide" : !on ? null : id && inView.has(id) && n++ < (found ? Infinity : limit) ? "show" : "hide";
      if (as === null) tr.removeAttribute("data-olf");
      else if (tr.getAttribute("data-olf") !== as) tr.setAttribute("data-olf", as);
      if (id && v.ready && opts.status) statusCell(v, tr, id);
    }
    rendered = n;
    searchMarks(v, items);
    root.classList.toggle("olf-sorted", !!v.sort);
    if (v.ready && opts.status) statusHeader(v);
  }

  function update() {
    const d = dashboard();
    if (!v.projects.size) {
      const onPage = projectsOnPage();
      if (onPage) setProjects(onPage);
    }
    v.ready = (loaded || !!cached) && v.projects.size > 0;
    v.stored = !!storageProject || agreed;
    v.state = folders.state;
    if (loaded && v.current && !v.state.folders[v.current]) v.current = null;
    v.browsing = browsing(d);
    root.classList.toggle("olf-browsing", v.browsing);
    root.classList.toggle("olf-in-folder", v.browsing && v.current !== null);
    // (nothing to show yet: on Overleaf's "All projects", its rows give way to skeleton ones)
    root.classList.toggle("olf-loading", !v.ready && !v.error && /^\/project\/?$/.test(location.pathname) && !d?.searchText);
    const s = v.state;
    v.found = v.browsing && v.query.trim() ? search(v, v.query) : null;
    inView = v.found
      ? new Set(v.found.projects.keys())
      : new Set(v.current ? Object.keys(s.projects).filter((p) => s.projects[p] === v.current && v.projects.has(p)) : [...v.projects.keys()].filter((p) => !s.folders[s.projects[p]]));
    mark();
    // (sorting by status, or searching: the whole folder rendered, every match shown, best first)
    const want = v.sort || v.found ? inView.size : Math.min(limit, inView.size);
    // (more coming: Overleaf to render more of its list, or what it has, not drawn yet; or
    // its first render, before its list's made: "No projects")
    const loading = v.browsing && rendered < want && (d!.hiddenProjectsCount > 0 || drawn < d!.visibleProjects.length || !d!.visibleProjects.length);
    v.page = v.found
      ? { shown: rendered, total: inView.size, loading, missing: Math.max(0, inView.size - rendered) }
      : { shown: Math.min(rendered, limit), total: inView.size, loading, missing: Math.max(0, Math.min(limit, inView.size) - rendered) };
    // (sorting by status, out of a folder: all of Overleaf's list rendered, to be sorted; a
    // search: its matches anywhere in the list, rendered at once)
    if (d?.hiddenProjectsCount && ((v.sort && !v.browsing) || v.found)) d.showAllProjects();
    if (loading && d!.hiddenProjectsCount > 0) {
      // (Overleaf's list sorted, by date first: a folder in use near its top, 20 more at a
      // time finding it; one of old projects far down, then all at once)
      if (steps++ < 10) d!.loadMoreProjects();
      else d!.showAllProjects();
    }
    renderSidebar(v);
    renderTable(v);
    opts.drawn?.(v);
  }

  folders.onError = (e) => dialog({ title: "Couldn't save the folders", text: `${e.message}. Your changes stay here, and are saved with the next one.`, ok: "OK", cancel: false });
  const unsubscribe = folders.subscribe((s) => {
    if (loaded) writeCache(s);
    update();
  });
  // (read once the page is parsed: its projects are in it)
  const load = () =>
    Promise.all([folders.load(), listProjects(), storage.find?.()])
      .then(([, projects, storageId]) => {
        storageProject = storageId ?? storageProject;
        setProjects(projects);
        loaded = true;
        writeCache(folders.state);
        update();
      })
      .catch((e) => {
        v.error = `Couldn't load the folders: ${e?.message ?? e}`;
        update();
      });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();

  // (React re-making a part this hangs on to, or the dashboard's own state changing: drawn again)
  const stop = watch(update, () => !document.querySelector(".olf-rows")?.isConnected || !document.querySelector(".olf-folders")?.isConnected, mark);
  // (now, the dashboard not there yet: its rows hidden from their first render, if loading)
  update();
  const onPop = () => {
    v.current = fromHash();
    limit = PAGE;
    steps = 0;
    update();
  };
  window.addEventListener("popstate", onPop);
  const onClick = (e: MouseEvent) => {
    const t = e.target as Element;
    // (Overleaf's own filters and tags: the top level, or out of browsing)
    if (t.closest?.("#project-list-root .project-list-filters:not(.olf-folders) :is(button, a)")) {
      v.current = null;
      v.query = "";
      limit = PAGE;
      steps = 0;
      update();
    }
    // (one of Overleaf's own sorts: not by status any more)
    if (v.sort && t.closest?.("#project-list-root thead th:not(.olf-status-col) .table-header-sort-btn")) v.sortBy(null);
    // (its "select all": the rows shown only)
    if (v.browsing && t.closest?.("#project-list-root thead input[type=checkbox]")) {
      e.preventDefault();
      e.stopPropagation();
      const d = dashboard();
      if (!d) return;
      const ids = [...document.querySelectorAll(`${PROJECT_ROWS}[data-olf="show"] [data-project-id]`)].map((el) => el.getAttribute("data-project-id")!);
      const all = ids.length > 0 && ids.every((p) => d.selectedProjectIds.has(p));
      d.setSelectedProjectIds(new Set(all ? [] : ids));
    }
  };
  document.addEventListener("click", onClick, true);
  const stopDrag = dragAndDrop(v);

  return () => {
    stop();
    stopDrag();
    unsubscribe();
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("click", onClick, true);
    document.querySelectorAll(".olf-folders, .olf-rows, .olf-crumbs, .olf-new-folder, .olf-footer, .olf-status-col, .olf-status-cell").forEach((el) => el.remove());
    document.querySelectorAll("[data-olf]").forEach((el) => el.removeAttribute("data-olf"));
    root.classList.remove("olf-browsing", "olf-in-folder", "olf-loading", "olf-sorted");
    root.removeAttribute(MOUNTED);
  };
}

/**
 * The search (query.ts's language): what matches `q` under the open folder
 * (everything, at the top level). A project's words are its name, with its
 * folder path, owner and tags as context, so "thesis draft" finds a "Draft"
 * in the "Thesis" folder; its filters (owner, tag, status, folder, dates)
 * must all hold. Folders are found by their names, when the query is words
 * only (a filter says what projects are, not folders).
 */
function search(v: View, q: string): NonNullable<View["found"]> {
  const s = v.state;
  const query = parse(q);
  const under = v.current ? subtree(s, v.current) : null;
  const tags = new Map<string, string[]>();
  for (const t of dashboard()?.tags ?? []) for (const p of t.project_ids ?? []) tags.set(p, [...(tags.get(p) ?? []), t.name]);
  const statuses = new Map(statusesOf(s).map((x) => [x.id, x.name]));
  const now = Date.now();
  const projects = new Map<string, Match>();
  for (const [id, p] of v.projects) {
    const f = s.projects[id];
    const inFolder = f !== undefined && !!s.folders[f];
    if (under && !(inFolder && under.has(f))) continue;
    const chain: string[] = [];
    for (let x: Id | null = inFolder ? f : null; x && s.folders[x]; x = s.folders[x].parent) chain.push(s.folders[x].name);
    const it: Item = {
      name: p.name,
      path: inFolder ? pathOf(s, f) : "",
      folders: chain,
      owner: ownerName(p),
      ownerEmail: p.owner?.email,
      mine: p.accessLevel === "owner",
      tags: tags.get(id) ?? [],
      status: s.status?.[id] ? statuses.get(s.status[id]) : undefined,
      updated: Date.parse(p.lastUpdated),
    };
    const m = matches(query, it, now);
    if (m) projects.set(id, m);
  }
  const folders: { id: Id; match: Match }[] = [];
  if (query.words.trim() && !query.filters.length)
    for (const [id, f] of Object.entries(s.folders)) {
      if (id === v.current || (under && !under.has(id))) continue;
      const m = fuzzy(query.words, f.name, f.parent ? pathOf(s, f.parent) : "");
      if (m) folders.push({ id, match: m });
    }
  folders.sort((a, b) => b.match.score - a.match.score || s.folders[a.id].name.localeCompare(s.folders[b.id].name));
  return { query, projects, folders };
}

/** What the search box suggests a filter's values from: the owners, tags, statuses and folders there are. */
export function vocabulary(v: View): Vocabulary {
  const owners = new Set<string>();
  for (const p of v.projects.values()) owners.add(ownerName(p));
  return {
    owners: [...owners].sort(),
    tags: (dashboard()?.tags ?? []).map((t) => t.name).sort(),
    statuses: statusesOf(v.state).map((x) => x.name),
    folders: [...new Set(Object.values(v.state.folders).map((f) => f.name))].sort(),
  };
}

/** The folders from the open one (not included) down to `id`, as "Research › CGRA"; "" if `id` is the open one. */
export function relPath(v: View, id: Id): string {
  const names: string[] = [];
  for (let f: Id | null = id; f && f !== v.current && v.state.folders[f]; f = v.state.folders[f].parent) names.unshift(v.state.folders[f].name);
  return names.join(" › ");
}

/**
 * Searching: each project row shown says where it is under the open folder
 * (a link to that folder), and the names' matched letters are highlighted
 * (the CSS Custom Highlight API: ranges over the text React rendered, which
 * is left as it is). Not searching: none of it.
 */
function searchMarks(v: View, items: { tr: HTMLElement; id: string | undefined }[]) {
  const ranges: Range[] = [];
  for (const { tr, id } of items) {
    const want = v.found && id && tr.getAttribute("data-olf") === "show" ? v.state.projects[id] : undefined;
    const where = want && v.state.folders[want] && want !== v.current ? relPath(v, want) : "";
    let chip = tr.querySelector<HTMLElement>(":scope > td.dash-cell-name .olf-path");
    if (!where) chip?.remove();
    else if (!chip || chip.dataset.folder !== want || chip.dataset.path !== where) {
      chip?.remove();
      chip = pathChip(v, want!, where);
      tr.querySelector(":scope > td.dash-cell-name")?.append(chip);
    }
    const m = v.found && id ? v.found.projects.get(id) : undefined;
    const name = id ? v.projects.get(id)?.name : undefined;
    const link = tr.querySelector("td.dash-cell-name a");
    if (m && name) ranges.push(...textRanges(link, name, m.spans));
    // (what else the query found in the row: the owner it names, the tags, the folder)
    if (m && v.found) {
      const { words, filters } = v.found.query;
      const terms = (key: string) => filters.filter((f) => f.key === key && !f.not).flatMap((f) => f.values);
      const free = words.split(/\s+/).filter((w) => w.length >= 2);
      const owners = terms("owner").map((o) => (/^(me|you|mine)$/i.test(o) ? "You" : o));
      for (const cell of tr.querySelectorAll(":scope > td.dash-cell-owner")) ranges.push(...termRanges(cell, [...owners, ...free]));
      for (const el of tr.querySelectorAll(":scope > td.dash-cell-name *")) {
        if (el === link || link?.contains(el)) continue;
        if (el.closest(".olf-path")) ranges.push(...termRanges(el, [...terms("in"), ...free], true));
        else ranges.push(...termRanges(el, [...terms("tag"), ...free], true));
      }
    }
  }
  for (const { id, match } of v.found?.folders ?? []) {
    const link = document.querySelector(`.olf-rows tr[data-folder="${id}"] .olf-folder-link`);
    ranges.push(...textRanges(link, v.state.folders[id]?.name ?? "", match.spans));
  }
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !H) return;
  if (ranges.length) css.highlights.set("olf-match", new H(...ranges));
  else css.highlights.delete("olf-match");
}

/** "in Research › CGRA", a link to that folder: a search result's place. */
export function pathChip(v: View, folder: Id, where: string): HTMLElement {
  const a = h("a", { href: `#folder=${folder}`, class: "olf-path", "data-folder": folder, "data-path": where, title: `Open ${where}` }, icon("folder"), where);
  a.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    v.open(folder);
  };
  return a;
}

/** Ranges over where `terms` occur in `el`'s text (`own`: its own text nodes only, not its children's). */
function termRanges(el: Element, terms: string[], own = false): Range[] {
  if (!terms.length) return [];
  const out: Range[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (own && t.parentNode !== el) continue;
    for (const [a, b] of occurrences(t.textContent ?? "", terms)) {
      const r = document.createRange();
      r.setStart(t, a);
      r.setEnd(t, b);
      out.push(r);
    }
  }
  return out;
}

/** Ranges over `spans` of `name`, in the text node of `el` that holds it. */
function textRanges(el: Element | null, name: string, spans: [number, number][]): Range[] {
  if (!el) return [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const at = (t.textContent ?? "").indexOf(name);
    if (at < 0) continue;
    return spans.map(([a, b]) => {
      const r = document.createRange();
      r.setStart(t!, at + a);
      r.setEnd(t!, at + b);
      return r;
    });
  }
  return [];
}

const fromHash = () => /^#folder=([\w-]+)$/.exec(location.hash)?.[1] ?? null;

function readCache(): State | null {
  try {
    return JSON.parse(localStorage.getItem(CACHE) ?? "null");
  } catch {
    return null;
  }
}
function writeCache(s: State) {
  try {
    localStorage.setItem(CACHE, JSON.stringify(s));
  } catch {}
}

function dragAndDrop(v: View): () => void {
  /** What's being dragged: project ids, or a folder. */
  let dragging: { projects: string[] } | { folder: Id } | null = null;
  // (a project row draggable as a whole, from where it's grabbed)
  const onPointerDown = (e: PointerEvent) => {
    const tr = (e.target as Element).closest?.<HTMLElement>(PROJECT_ROWS);
    if (tr && !(e.target as Element).closest("input, button, label")) tr.draggable = true;
  };
  const onDragStart = (e: DragEvent) => {
    const el = e.target as Element;
    const folder = el.closest?.<HTMLElement>("[data-folder]")?.dataset.folder;
    const tr = el.closest?.(PROJECT_ROWS);
    let label: string;
    if (folder) {
      dragging = { folder };
      label = v.state.folders[folder]?.name ?? "";
    } else if (tr) {
      const id = tr.querySelector("[data-project-id]")?.getAttribute("data-project-id") ?? tr.querySelector<HTMLAnchorElement>("a[href^='/project/']")?.pathname.split("/")[2];
      if (!id) return;
      const sel = dashboard()?.selectedProjectIds;
      const projects = sel?.has(id) ? [...sel] : [id];
      dragging = { projects };
      label = projects.length > 1 ? `${projects.length} projects` : (v.projects.get(id)?.name ?? "1 project");
    } else return;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", label);
    // (the drag image: a chip with what's moving)
    const ghost = h("div", { class: "olf-ghost" }, icon("folder" in dragging ? "folder" : "description"), label);
    document.body.append(ghost);
    e.dataTransfer!.setDragImage(ghost, 14, 14);
    setTimeout(() => ghost.remove());
  };
  const clear = () => document.querySelectorAll(".olf-drop").forEach((el) => el.classList.remove("olf-drop"));
  const onDragEnd = () => {
    dragging = null;
    clear();
  };
  /** The drop target under `e` and the folder it means ("" the top level), if `dragging` may go there. */
  const target = (e: DragEvent): [HTMLElement, string] | null => {
    const el = (e.target as Element).closest?.<HTMLElement>("[data-drop]");
    if (!el || !dragging) return null;
    const to = el.dataset.drop!;
    if ("folder" in dragging) return canMove(v.state, dragging.folder, to || null) ? [el, to] : null;
    return dragging.projects.some((p) => (v.state.projects[p] ?? "") !== to) ? [el, to] : null;
  };
  const onDragOver = (e: DragEvent) => {
    if (!dragging) return;
    clear();
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    t[0].classList.add("olf-drop");
    e.dataTransfer!.dropEffect = "move";
  };
  const onDrop = (e: DragEvent) => {
    const t = target(e);
    const what = dragging;
    onDragEnd();
    if (!t || !what) return;
    e.preventDefault();
    const to = t[1] || null;
    if ("folder" in what) void v.change({ op: "move", id: what.folder, parent: to });
    else void v.change({ op: "file", projects: what.projects, folder: to }).then(() => dashboard()?.setSelectedProjectIds(new Set()));
  };
  const on = [["pointerdown", onPointerDown], ["dragstart", onDragStart], ["dragend", onDragEnd], ["dragover", onDragOver], ["drop", onDrop]] as const;
  for (const [type, fn] of on) document.addEventListener(type, fn as EventListener, true);
  return () => {
    for (const [type, fn] of on) document.removeEventListener(type, fn as EventListener, true);
  };
}

function addStyle() {
  if (document.getElementById("olf-style")) return;
  const s = h("style", { id: "olf-style" });
  s.textContent = `
  /* the project rows: of the open folder's page only, browsing; the storage's never; none, loading */
  .olf-browsing ${PROJECT_ROWS}:not([data-olf="show"]), ${PROJECT_ROWS}[data-olf="hide"], .olf-loading ${PROJECT_ROWS} { display: none; }
  /* (Overleaf's "Show 20 more", "Showing n out of m": its list's, not the folder's; the folder's own instead) */
  :is(.olf-browsing, .olf-loading) #project-list-root div.text-center:has(> p):not(.olf-footer) { display: none; }
  html:not(.olf-browsing) .olf-footer { display: none; }
  .olf-footer .spinner-border { width: 1rem; height: 1rem; border-width: 2px; margin-right: 6px; vertical-align: -2px; }
  /* the search box's suggestions (query.ts), under it */
  .olf-search { position: relative; }
  .olf-suggest { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 1060; max-height: 320px; overflow-y: auto; margin: 0; }
  .olf-suggest .dropdown-item { display: flex; justify-content: space-between; gap: 12px; }
  .olf-suggest .dropdown-item small { opacity: .65; white-space: nowrap; }
  #project-list-root .olf-suggest .dropdown-item.active, .olf-suggest .dropdown-item.active { background: rgb(50 101 178 / 30%) !important; color: var(--content-primary-themed, inherit) !important; }
  .olf-suggest .dropdown-item { color: var(--content-primary-themed, inherit); }
  .olf-suggest .olf-suggest-hint { padding: 4px 16px 2px; font-size: 12px; opacity: .65; }
  /* (the search and the buttons on one row: the search takes what "New folder" and "New project" leave) */
  @media (min-width: 768px) {
    #project-list-root .row:has(> .col-auto .olf-new-folder) > :has(> .project-search) { flex: 1 1 0; width: auto; max-width: none; min-width: 0; }
  }
  /* our search box, in place of Overleaf's while browsing; a result's place; the matched letters */
  .olf-browsing #project-list-root .form-control-wrapper:has(> input.form-control:not(.olf-search-input)) { display: none !important; }
  html:not(.olf-browsing) .olf-search { display: none !important; }
  .olf-path { display: inline-flex; align-items: center; gap: 2px; margin-left: 8px; padding: 0 6px; border-radius: 6px; font-size: 12px;
    color: inherit; opacity: .7; text-decoration: none; background: color-mix(in srgb, currentColor 8%, transparent); white-space: nowrap; }
  .olf-path:hover { opacity: 1; text-decoration: underline; }
  .olf-path .material-symbols { font-size: 14px; }
  ::highlight(olf-match) { background-color: rgb(255 199 0 / 45%); color: inherit; }
  /* the status column */
  #project-list-root .olf-status-col, #project-list-root .olf-status-cell { width: 9.5rem; white-space: nowrap; }
  .olf-status { display: inline-flex; align-items: center; gap: 6px; padding: 1px 10px 1px 8px; border: 0; border-radius: 999px;
    font-size: 13px; line-height: 22px; color: inherit; background: color-mix(in srgb, var(--c) 22%, transparent); cursor: pointer; }
  .olf-status::before, .olf-status-item::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); flex: none; }
  .olf-status:hover { background: color-mix(in srgb, var(--c) 36%, transparent); }
  .olf-status-empty { background: transparent; opacity: 0; padding-left: 4px; }
  .olf-status-empty::before { display: none; }
  .olf-status-empty .material-symbols { font-size: 16px; }
  tr:hover .olf-status-empty, .olf-status-empty:focus-visible { opacity: .65; }
  .olf-status-item { display: inline-flex; align-items: center; gap: 8px; }
  .olf-status-item.current { font-weight: 600; }
  /* the statuses' dialog: a list, and Overleaf's colour picker */
  .olf-status-list { margin: 12px 0; }
  .olf-status-list li { display: flex; align-items: center; gap: 2px; padding: 4px 0; border-bottom: 1px solid var(--border-divider, #dfe3ea); }
  .olf-status-list .olf-status-name { flex: 1; margin-left: 8px; }
  .olf-status-list .olf-count { opacity: .6; }
  .olf-icon-btn { padding: 2px 4px; line-height: 1; color: inherit; }
  .olf-icon-btn .material-symbols { font-size: 18px; }
  .olf-icon-btn[disabled] { opacity: .25; }
  .olf-new-status { display: inline-flex; align-items: center; gap: 4px; }
  .olf-new-status .material-symbols { font-size: 18px; }
  .olf-colours { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .olf-colour { width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: var(--c); cursor: pointer; }
  .olf-colour.selected { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--c, #1b222c); }
  .olf-colour-custom { background: conic-gradient(#f04343, #e4ca3e, #33cf67, #43a7f0, #b943f0, #f04343); appearance: none; -webkit-appearance: none; }
  .olf-colour-custom::-webkit-color-swatch-wrapper { padding: 0; opacity: 0; }
  .olf-sort-by { margin-left: 6px; font-weight: normal; opacity: .7; }
  .olf-sort-item { display: inline-flex; align-items: center; gap: 6px; }
  .olf-sort-item .material-symbols { font-size: 16px; }
  /* (sorting by status: Overleaf's own sort arrow not shown) */
  .olf-sorted #project-list-root thead th:not(.olf-status-col) .table-header-sort-btn .material-symbols { display: none; }
  /* the table's folder rows */
  /* (as a project's row: its name in line with theirs, its icon where their checkbox is) */
  .olf-rows .olf-folder-link { color: inherit; text-decoration: none; }
  .olf-rows .olf-folder-link:hover { text-decoration: underline; }
  .olf-rows .olf-folder-icon { line-height: 1; }
  .olf-rows .material-symbols { font-size: 20px; vertical-align: -4px; color: var(--content-secondary-themed, #8d96a5); font-variation-settings: "FILL" 1; }
  .olf-rows .olf-folder-link .material-symbols { margin-right: 6px; }
  .olf-rows .olf-count { opacity: .6; }
  .olf-rows tr.olf-folder-row { cursor: default; }
  .olf-rows .olf-empty td { padding: 24px; text-align: center; opacity: .7; }
  #project-list-root tr.olf-drop > td { background-color: rgb(50 101 178 / 22%) !important; }
  #project-list-root tr.olf-drop > td:first-child { box-shadow: inset 3px 0 0 var(--border-active, #3265b2); }
  /* skeleton rows, while loading */
  .olf-skeleton td { padding-top: 14px; padding-bottom: 14px; }
  .olf-bar { display: block; height: 12px; border-radius: 6px; background: currentColor; opacity: .12; animation: olf-pulse 1.2s ease-in-out infinite; }
  @keyframes olf-pulse { 50% { opacity: .05; } }
  html:not(.olf-browsing):not(.olf-loading) .olf-rows, html:not(.olf-browsing) .olf-new-folder { display: none !important; }
  /* the path over the table, in place of Overleaf's heading inside a folder */
  .olf-crumbs { display: flex !important; align-items: center; gap: 2px; min-width: 0; margin-top: 0 !important; }
  .olf-crumbs a, .olf-crumbs span[data-drop] { padding: 0 6px; border-radius: 6px; color: inherit; text-decoration: none; white-space: nowrap; }
  .olf-crumbs a { opacity: .75; }
  .olf-crumbs a:hover { opacity: 1; text-decoration: underline; }
  .olf-crumbs .olf-sep { opacity: .5; font-size: 22px; }
  .olf-crumbs .olf-drop { outline: 2px dashed var(--border-active, #3265b2); }
  html:not(.olf-in-folder) .olf-crumbs, html.olf-in-folder #project-list-root h1.project-list-title:not(.olf-crumbs) { display: none !important; }
  #project-list-root .olf-new-folder { display: inline-flex; align-items: center; gap: 6px; margin-right: 8px; }
  .olf-new-folder .material-symbols { font-size: 18px; }
  #project-list-root .ms-auto.col-auto:has(> .olf-new-folder) { display: flex; align-items: center; }
  /* the sidebar's tree */
  /* (as Overleaf's tags: a 16px icon at its 48px padding, then the name; the expand arrow
     in the padding before the icon, a level deeper one arrow's width further in) */
  .olf-folders .olf-twisty { display: inline-flex; flex: none; width: 16px; justify-content: center; margin-left: calc(var(--olf-depth, 0) * 16px - 16px); }
  .olf-folders .olf-twisty .material-symbols { font-size: 16px; }
  .olf-folders .olf-icon { flex: none; width: 16px; font-size: 16px; overflow: hidden; }
  .olf-folders .tag-name { display: flex; align-items: center; }
  .olf-folders .tag-menu .dropdown-toggle::after { display: none; }
  .olf-folders .tag-menu .material-symbols { font-size: 18px; }
  .olf-folders .olf-drop > .tag-name, .olf-folders li.dropdown-header.olf-drop {
    outline: 2px dashed var(--border-active, #3265b2); outline-offset: -2px; border-radius: var(--border-radius-base, 4px); }
  .olf-folders .olf-note { padding: 4px 12px; font-size: 13px; color: var(--content-danger, #b83a33); }
  /* pieces */
  .olf-ghost { position: fixed; top: -100px; left: 0; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px;
    border-radius: 8px; background: #fff; color: #1b222c; font: 600 14px/1.4 system-ui, sans-serif; box-shadow: 0 4px 14px rgb(0 0 0 / 35%); }
  .olf-ghost .material-symbols { font-size: 18px; color: #3265b2; }
  .olf-modal .olf-error { min-height: 1.5em; margin-top: 4px; color: var(--content-danger, #b83a33); }
  .olf-menu { z-index: 1060; }
  `;
  // (from the page's start: no <head> yet, maybe)
  (document.head ?? document.documentElement).append(s);
}
