// The project dashboard's settings bridge (the content scripts' world, from
// the page's start; bundled to dist/dashboard.js, a content script being a
// classic script): the folders (folders/main.ts, in the page's world) can't
// read the extension's settings, so they're copied here into the page's
// localStorage, read there at once, and each change posted; and what the
// folders settle there saved: a tip turned off or seen, the extension's
// terms accepted (terms.ts: one acceptance with ⚡ Instant's).

import { TERMS } from "./terms.ts";

if (!/^\/project\/([0-9a-f]{24}|mock)/.test(location.pathname)) {
  const send = async () => {
    const s = await chrome.storage.local.get(["enabled", "folders", "statusColumn", "hideData", "foldersTipOff", "searchTipSeen", "accepted"]);
    const settings = {
      on: s.enabled !== false && s.folders !== false,
      status: s.statusColumn === true,
      hide: s.hideData === true,
      tip: !s.foldersTipOff,
      searchTip: !s.searchTipSeen,
      accepted: s.accepted === TERMS,
      license: chrome.runtime.getURL("LICENSE.txt"),
    };
    try {
      localStorage.setItem("phitex:dashboard", JSON.stringify(settings));
    } catch {}
    window.postMessage({ src: "phitex-dashboard", settings }, location.origin);
  };
  void send();
  chrome.storage.onChanged.addListener((_, area) => {
    if (area === "local") void send();
  });
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.src !== "phitex-folders") return;
    if (e.data.tipOff === true) void chrome.storage.local.set({ foldersTipOff: true });
    if (e.data.searchTipSeen === true) void chrome.storage.local.set({ searchTipSeen: true });
    if (e.data.accept === true) void chrome.storage.local.set({ accepted: TERMS });
  });
}
