// Overleaf's project dashboard, from the page's world (manifest "world":
// "MAIN"): its React state (ProjectListContext, found through the DOM), its
// project list, and the request helper the storage (project.ts) uses.
// Everything internal to Overleaf's dashboard lives here: when Overleaf
// changes, this file does.

export type Project = {
  id: string;
  name: string;
  accessLevel: string;
  lastUpdated: string;
  archived?: boolean;
  trashed?: boolean;
  owner?: { id: string; firstName?: string; lastName?: string; email?: string };
};

/** The part of Overleaf's ProjectListContextValue used here. */
export type Dashboard = {
  filter: string;
  selectedTagId?: string;
  /** The user's tags (Overleaf's), as shown. */
  tags: { _id: string; name: string; project_ids?: string[] }[];
  searchText: string;
  /** The projects the table renders (a page of them, unless all shown). */
  visibleProjects: Project[];
  hiddenProjectsCount: number;
  selectedProjectIds: Set<string>;
  /** Renders up to 20 more. */
  loadMoreProjects(): void;
  setSelectedProjectIds(ids: Set<string>): void;
  selectFilter(filter: string): void;
  /** Renders them all. */
  showAllProjects(): void;
};

/** Who owns a project, as the table says it: "You", else the owner's name. */
export function ownerName(p: Project): string {
  if (p.accessLevel === "owner") return "You";
  const o = p.owner;
  return [o?.firstName, o?.lastName].filter(Boolean).join(" ").trim() || o?.email || "Someone";
}

/** The dashboard's state as of its last render (read it again after a change), or null off the dashboard. */
export function dashboard(): Dashboard | null {
  const el = document.querySelector("#project-list-root .project-list-filters, #project-list-root table");
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  for (let f = key ? (el as any)[key] : null; f; f = f.return) {
    const v = f.memoizedProps?.value;
    if (v && typeof v.selectFilter === "function" && typeof v.showAllProjects === "function" && v.selectedProjectIds) return v;
  }
  return null;
}

/**
 * Calls `fn` whenever the dashboard's filter, tag, search or listed projects
 * change, or `stale()` says so (say, React re-made the sidebar), and once
 * ready; `onMutation` on every change to the page. Both before the change
 * is painted (not on an animation frame: none come in a hidden tab, which
 * would show it unchanged when brought up). From the page's start on (the
 * dashboard's not there yet).
 */
export function watch(fn: (d: Dashboard) => void, stale = () => false, onMutation = () => {}): () => void {
  let last: unknown[] = [];
  const check = () => {
    const d = dashboard();
    if (!d) return;
    const now = [d.filter, d.selectedTagId, d.searchText, d.visibleProjects, d.hiddenProjectsCount, d.selectedProjectIds];
    if (now.every((v, i) => v === last[i]) && !stale()) return;
    last = now;
    fn(d);
  };
  // (`fn` drawing changes the page too: drawn again only if the dashboard changed meanwhile)
  const mo = new MutationObserver(() => {
    onMutation();
    check();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  check();
  return () => mo.disconnect();
}

export const csrf = () => document.querySelector<HTMLMetaElement>('meta[name="ol-csrfToken"]')?.content ?? "";

export async function call(method: string, url: string, body?: object): Promise<any> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Csrf-Token": csrf() },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Overleaf refused (${r.status} on ${method} ${url})`);
  return r.status === 204 ? undefined : r.json().catch(() => undefined);
}

/** All the user's projects, archived and trashed ones too, as the page came with them (no request), or null. */
export function projectsOnPage(): Project[] | null {
  try {
    return JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="ol-prefetchedProjectsBlob"]')!.content).projects ?? null;
  } catch {
    return null;
  }
}

/** All the user's projects, archived and trashed ones too, as they are now (asked for). */
export async function fetchProjects(): Promise<Project[]> {
  return (await call("POST", "/api/project", { sort: { by: "lastUpdated", order: "desc" } })).projects;
}

/** All the user's projects, archived and trashed ones too: the page's, else asked for. */
export async function listProjects(): Promise<Project[]> {
  return projectsOnPage() ?? (await fetchProjects());
}
