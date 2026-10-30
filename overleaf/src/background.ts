// The service worker: makes sure the offscreen document (which runs the
// core's worker) exists, and fetches packs ahead. Content scripts then
// connect to the offscreen document directly.

import "./platform.ts";
import { prefetch } from "./common/prefetch.ts";
import { settled } from "./settings.ts";
import { allMeta, clearPacks } from "./common/packstore.ts";

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // (Firefox: no offscreen documents; the background page is the core's
  // page itself, firefox-bg.html, always there)
  if (!chrome.offscreen) return;
  const url = chrome.runtime.getURL("offscreen.html");
  const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType], documentUrls: [url] });
  if (have.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url, reasons: ["WORKERS" as chrome.offscreen.Reason], justification: "Runs the PhiTeX typesetter (wasm) in a worker, locally." })
    .finally(() => (creating = null));
  await creating;
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  // (Shelf asks for a newer extension: the store's update, checked now)
  if (m?.type === "update-check") {
    void chrome.runtime.requestUpdateCheck?.().catch(() => undefined);
    return;
  }
  // (the panel's Clear cache: the packs kept in this browser, and how much they held)
  if (m?.type === "clear-cache") {
    allMeta()
      .then(async (all) => {
        let freed = 0;
        for (const p of all.values()) freed += p.bytes;
        await clearPacks();
        reply({ freed });
      })
      .catch((e) => reply({ error: String(e) }));
    return true;
  }
  if (m?.type === "ensure-offscreen") {
    ensureOffscreen().then(() => reply(true), (e) => reply(String(e)));
    return true;
  }
});

// What's new: after an update, the notes the user hasn't seen show once in
// Overleaf; a fresh install sees the welcome tip instead, so its notes count
// as seen.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  const version = chrome.runtime.getManifest().version;
  if (reason === "install") void chrome.storage.local.set({ newsSeen: version });
  // (the settings in this version's format: an update's older ones upgraded)
  void settled().catch((e) => console.error("[phitex] settings:", e));
});

// Packs fetched ahead (prefetch.ts): after an install or update, at each
// browser start, and every few hours (a new Shelf release; a run the
// service worker's stop cut short). Progress goes to chrome.storage, for
// the popup (and, each pack, keeps the service worker going).
const ahead = () => void prefetch((a) => void chrome.storage.local.set({ ahead: a })).catch(() => undefined);
chrome.runtime.onInstalled.addListener(ahead);
chrome.runtime.onStartup.addListener(ahead);
void chrome.alarms.create("prefetch", { periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener((a) => a.name === "prefetch" && ahead());
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "prefetch") ahead();
});
