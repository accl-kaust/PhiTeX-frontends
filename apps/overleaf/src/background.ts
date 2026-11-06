// The service worker (in Firefox, the background page, firefox-bg.html):
// fetches packs ahead and answers the tabs' asks (an update check, the
// cache's settings). The core is each tab's own, in its engine iframe (engine.ts).

import "./platform.ts";
import { prefetch } from "./common/prefetch.ts";
import { settled } from "./settings.ts";
import { DEFAULT_CAP_MB, allMeta, capBytes, clearPacks, evict, kvGet, kvSet } from "./common/packstore.ts";
import { setAheadOff } from "./common/prefetch.ts";

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
  // (the page's Settings: the packs kept, their cap and the fetch ahead, as the popup shows them)
  if (m?.type === "cache-stats") {
    Promise.all([allMeta(), capBytes().catch(() => DEFAULT_CAP_MB * 1048576), kvGet<boolean>("aheadOff").catch(() => false)])
      .then(([all, cap, aheadOff]) => {
        let bytes = 0;
        for (const p of all.values()) bytes += p.bytes;
        reply({ packs: all.size, bytes, capMB: Math.round(cap / 1048576), ahead: !aheadOff });
      })
      .catch((e) => reply({ error: String(e) }));
    return true;
  }
  if (m?.type === "cache-cap" && [100, 300, 1000].includes(m.mb)) {
    kvSet("capMB", m.mb)
      .then(() => evict())
      .then(() => reply({}), (e) => reply({ error: String(e) }));
    return true;
  }
  if (m?.type === "cache-ahead") {
    setAheadOff(!m.on)
      .then(() => (m.on && ahead(), reply({})), (e) => reply({ error: String(e) }));
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
