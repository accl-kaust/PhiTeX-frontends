// The web frontend's projects, kept in this browser (IndexedDB, the
// platform's "web" database: common/src/platform.ts): each project whole,
// its text files and its binary ones (figures), and its versions, saved by
// hand or every few minutes of editing, which Compare diffs against.

import { platform } from "../../../common/src/platform.ts";
import type { EngineChoice } from "../../../common/src/viewer/engines.ts";

export interface Project {
  id: string;
  name: string;
  files: Record<string, string>;
  binaries: Record<string, Uint8Array>;
  main: string;
  engine: EngineChoice;
  /** Date.now() of its last change. */
  updated: number;
  /** An example's copy: the example's fingerprint when copied (a newer example replaces an unedited copy). */
  sample?: string;
  /** Edited since it was made (an example's copy then kept as the visitor's own when the example changes). */
  edited?: boolean;
}

export interface Version {
  /** `${project}/${at}`. */
  id: string;
  project: string;
  /** Date.now() when saved. */
  at: number;
  /** The user's name for it ("" for an automatic one). */
  label: string;
  files: Record<string, string>;
}

const P = "web.projects";
const V = "web.versions";

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function projects(): Promise<Project[]> {
  const all = await platform().kv.all<Project>(P);
  return [...all.values()].sort((a, b) => b.updated - a.updated);
}

export function project(id: string): Promise<Project | undefined> {
  return platform().kv.get<Project>(P, id);
}

export function saveProject(p: Project): Promise<void> {
  return platform().kv.write([[P, p.id, { ...p, updated: Date.now() }]]);
}

/** The project and its versions gone. */
export async function deleteProject(id: string): Promise<void> {
  const vs = await versions(id);
  await platform().kv.write([[P, id, undefined], ...vs.map((v): [string, string, undefined] => [V, v.id, undefined])]);
}

/** The project's versions, newest first. */
export async function versions(projectId: string): Promise<Version[]> {
  const all = await platform().kv.all<Version>(V);
  return [...all.values()].filter((v) => v.project === projectId).sort((a, b) => b.at - a.at);
}

export async function saveVersion(p: Project, label: string): Promise<Version> {
  const at = Date.now();
  const v: Version = { id: `${p.id}/${at}`, project: p.id, at, label, files: { ...p.files } };
  await platform().kv.write([[V, v.id, v]]);
  return v;
}

/** At most this many automatic versions per project (the oldest dropped). */
const KEEP_AUTO = 20;

/** An automatic version, unless the newest one has the same files; the oldest automatic ones beyond KEEP_AUTO dropped. */
export async function autoVersion(p: Project): Promise<Version | null> {
  const vs = await versions(p.id);
  const same = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, t]) => b[k] === t);
  if (vs[0] && same(vs[0].files, p.files)) return null;
  const v = await saveVersion(p, "");
  const autos = vs.filter((x) => !x.label).slice(KEEP_AUTO - 1);
  if (autos.length) await platform().kv.write(autos.map((x): [string, string, undefined] => [V, x.id, undefined]));
  return v;
}
