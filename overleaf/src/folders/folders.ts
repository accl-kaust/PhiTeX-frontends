// The folders: a tree of named folders, each project in at most one (as a
// file in a file system); and each project's status, at most one, from an
// ordered list the user makes as they like (idea, drafting, ... to begin
// with), as Overleaf's tags. Pure: no DOM, no Overleaf. Every change is an Op,
// data, so a change made against a stale copy can be replayed onto a newer
// one (sync.ts); applying one never throws, an Op that no longer fits (its
// folder deleted meanwhile) changes nothing.

import { upgrade, type Steps } from "../common/format.ts";

export type Id = string;

/** The stored folders' format (common/src/format.ts): written with every save, checked at every read. */
export const FORMAT = 1;
/** From each older format to the next (none yet: 1 is the first). A change of shape is a new format and a step here. */
export const STEPS: Steps = {};

export type State = {
  /** Its format (FORMAT, once read). */
  version: number;
  /** Bumped on every save: a copy older than the stored one is stale. */
  rev: number;
  folders: Record<Id, { name: string; parent: Id | null }>;
  /** Project id → its folder. */
  projects: Record<string, Id>;
  /** The statuses a project can have, in order (absent: STATUSES). */
  statuses?: Status[];
  /** Project id → its status. */
  status?: Record<string, Id>;
};

export type Status = { id: Id; name: string; color: string };

/** Where a paper stands, in order: the statuses to begin with, until the user changes them. */
export const STATUSES: Status[] = [
  { id: "idea", name: "idea", color: "#8d96a5" },
  { id: "drafting", name: "drafting", color: "#3d7fe0" },
  { id: "submitted", name: "submitted", color: "#d8901a" },
  { id: "revising", name: "revising", color: "#b35cd6" },
  { id: "accepted", name: "accepted", color: "#1fa463" },
];

export const statusesOf = (s: State): Status[] => s.statuses ?? STATUSES;

export const MAX_STATUS = 40;

/** Why `name` can't name a status (`self`: the one being renamed), or null. */
export function invalidStatus(s: State, name: string, self?: Id): string | null {
  name = name.trim();
  if (!name) return "Name is empty";
  if (name.length > MAX_STATUS) return `Name is over ${MAX_STATUS} characters`;
  if (statusesOf(s).some((x) => x.id !== self && x.name.toLowerCase() === name.toLowerCase())) return `"${name}" already exists`;
  return null;
}

export type Op =
  | { op: "create"; id: Id; parent: Id | null; name: string }
  | { op: "rename"; id: Id; name: string }
  | { op: "move"; id: Id; parent: Id | null }
  | { op: "delete"; id: Id }
  /** Puts projects in a folder; `folder` null: in none. */
  | { op: "file"; projects: string[]; folder: Id | null }
  /** Gives projects a status; `status` null: none. */
  | { op: "status"; projects: string[]; status: Id | null }
  /** A new status, last. */
  | { op: "addStatus"; status: Status }
  | { op: "editStatus"; id: Id; name?: string; color?: string }
  /** A status gone: its projects have none. */
  | { op: "removeStatus"; id: Id }
  /** A status moved to `to` in the order. */
  | { op: "moveStatus"; id: Id; to: number };

export type Folder = { id: Id; name: string; children: Folder[]; projects: string[] };

export const MAX_NAME = 100;

export const empty = (): State => ({ version: FORMAT, rev: 0, folders: {}, projects: {} });

/** Stored folders as this extension reads them: an older format's upgraded; a newer one's refused (NewerFormat). */
export const readState = (stored: unknown, steps = STEPS, format = FORMAT): State => upgrade<State>("Your folders", stored, format, steps);

export const newId = () => crypto.randomUUID().slice(0, 8);

/** `id` and every folder under it. */
export function subtree(s: State, id: Id): Set<Id> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, { parent }] of Object.entries(s.folders))
      if (parent && out.has(parent) && !out.has(f)) out.add(f), (grew = true);
  }
  return out;
}

/** "Research / PhD / Thesis". */
export function pathOf(s: State, id: Id): string {
  const names: string[] = [];
  for (let f: Id | null = id; f && s.folders[f]; f = s.folders[f].parent) names.unshift(s.folders[f].name);
  return names.join(" / ");
}

const siblings = (s: State, parent: Id | null) => Object.entries(s.folders).filter(([, f]) => f.parent === parent);

/** Why `name` can't name a folder in `parent` (`self`: the folder being renamed), or null. */
export function invalid(s: State, parent: Id | null, name: string, self?: Id): string | null {
  name = name.trim();
  if (!name) return "Name is empty";
  if (name.length > MAX_NAME) return `Name is over ${MAX_NAME} characters`;
  if (siblings(s, parent).some(([id, f]) => id !== self && f.name.toLowerCase() === name.toLowerCase()))
    return `"${name}" already exists here`;
  return null;
}

/** Whether folder `id` can move into `parent`. */
export const canMove = (s: State, id: Id, parent: Id | null) =>
  !!s.folders[id] && s.folders[id].parent !== parent && !(parent && subtree(s, id).has(parent)) &&
  invalid(s, parent, s.folders[id].name, id) === null;

export function apply(s: State, o: Op): State {
  const folders = { ...s.folders };
  const projects = { ...s.projects };
  const exists = (id: Id | null) => id === null || !!folders[id];
  switch (o.op) {
    case "create":
      if (folders[o.id] || !exists(o.parent) || invalid(s, o.parent, o.name)) return s;
      folders[o.id] = { name: o.name.trim(), parent: o.parent };
      break;
    case "rename":
      if (!folders[o.id] || invalid(s, folders[o.id].parent, o.name, o.id)) return s;
      folders[o.id] = { ...folders[o.id], name: o.name.trim() };
      break;
    case "move":
      if (!exists(o.parent) || !canMove(s, o.id, o.parent)) return s;
      folders[o.id] = { ...folders[o.id], parent: o.parent };
      break;
    case "delete": {
      if (!folders[o.id]) return s;
      const gone = subtree(s, o.id);
      for (const id of gone) delete folders[id];
      // (their projects: in no folder)
      for (const [p, f] of Object.entries(projects)) if (gone.has(f)) delete projects[p];
      break;
    }
    case "file":
      if (!exists(o.folder)) return s;
      for (const p of o.projects) o.folder ? (projects[p] = o.folder) : delete projects[p];
      break;
    case "status": {
      if (o.status !== null && !statusesOf(s).some((x) => x.id === o.status)) return s;
      const status = { ...s.status };
      for (const p of o.projects) o.status ? (status[p] = o.status) : delete status[p];
      return { ...s, status };
    }
    case "addStatus": {
      const list = statusesOf(s);
      if (list.some((x) => x.id === o.status.id) || invalidStatus(s, o.status.name)) return s;
      return { ...s, statuses: [...list, { ...o.status, name: o.status.name.trim() }] };
    }
    case "editStatus": {
      const list = statusesOf(s);
      if (!list.some((x) => x.id === o.id) || (o.name !== undefined && invalidStatus(s, o.name, o.id))) return s;
      return { ...s, statuses: list.map((x) => (x.id !== o.id ? x : { ...x, ...(o.name !== undefined && { name: o.name.trim() }), ...(o.color && { color: o.color }) })) };
    }
    case "removeStatus": {
      const list = statusesOf(s);
      if (!list.some((x) => x.id === o.id)) return s;
      const status = Object.fromEntries(Object.entries(s.status ?? {}).filter(([, x]) => x !== o.id));
      return { ...s, statuses: list.filter((x) => x.id !== o.id), status };
    }
    case "moveStatus": {
      const list = statusesOf(s);
      const from = list.findIndex((x) => x.id === o.id);
      if (from < 0) return s;
      const rest = list.filter((x) => x.id !== o.id);
      rest.splice(Math.max(0, Math.min(o.to, rest.length)), 0, list[from]);
      return { ...s, statuses: rest };
    }
  }
  return { ...s, folders, projects };
}

/** The folder tree (its top level), each level sorted by name; `known`: only these projects are listed. */
export function tree(s: State, known?: Set<string>): Folder[] {
  const byId = new Map<Id, Folder>(Object.entries(s.folders).map(([id, f]) => [id, { id, name: f.name, children: [], projects: [] }]));
  const top: Folder[] = [];
  for (const [id, f] of Object.entries(s.folders)) (f.parent && byId.get(f.parent)?.children || top).push(byId.get(id)!);
  for (const [p, f] of Object.entries(s.projects)) if (!known || known.has(p)) byId.get(f)?.projects.push(p);
  const sort = (fs: Folder[]) => {
    fs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    fs.forEach((f) => sort(f.children));
  };
  sort(top);
  return top;
}
