// The extension's settings (chrome.storage.local: the popup's switches, the
// tips seen, the terms accepted, ...) are the user's own, so versioned as
// such (common/src/format.ts): their format kept with them ("format"; one
// stored before it was kept is format 1), an older one taken through each
// step after an update; a newer one (a downgrade) left as it is, this
// version reading only the keys it knows. A setting never changes meaning
// within a format: renamed, or its values changed, is a new format and a
// step here.

import { NewerFormat, upgrade, type Steps } from "./common/format.ts";

export const FORMAT = 2;
/** `steps[n]`: all of format n's settings to format n + 1's. */
export const STEPS: Steps = {
  // (Compare's own tip gone, the panel's animated tip in its place: 12e89f1)
  1: ({ cmpTipNext: _n, cmpTipOff: _o, cmpUsed: _u, ...s }) => s,
};

/** `all` (chrome.storage.local's) in this extension's format: what to set and what to remove; null if as it is, or newer. */
export function upgradeSettings(all: Record<string, unknown>, steps = STEPS, format = FORMAT): { set: Record<string, unknown>; remove: string[] } | null {
  const found = typeof all.format === "number" ? all.format : 1;
  if (found === format && all.format === format) return null;
  try {
    const { version: _, ...next } = upgrade<{ version: number }>("Your settings", { ...all, version: found }, format, steps) as Record<string, unknown>;
    return { set: { ...next, format }, remove: Object.keys(all).filter((k) => !(k in next) && k !== "format") };
  } catch (e) {
    if (e instanceof NewerFormat) return null;
    throw e;
  }
}

/** The stored settings brought to this extension's format (after an install or update). */
export async function settled(): Promise<void> {
  const change = upgradeSettings(await chrome.storage.local.get(null));
  if (!change) return;
  if (change.remove.length) await chrome.storage.local.remove(change.remove);
  await chrome.storage.local.set(change.set);
}
