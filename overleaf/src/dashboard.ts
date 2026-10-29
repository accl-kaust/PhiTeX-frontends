// The project dashboard's settings bridge (the content scripts' world, from
// the page's start): the folders (folders/main.ts, in the page's world)
// can't read the extension's settings, so they're copied here into the
// page's localStorage, read there at once, and each change posted; and the
// folders' tip, turned off there, saved. No imports (a classic script).

(() => {
  if (/^\/project\/([0-9a-f]{24}|mock)/.test(location.pathname)) return;
  const send = async () => {
    const s = await chrome.storage.local.get(["enabled", "folders", "statusColumn", "hideData", "foldersTipOff"]);
    const settings = { on: s.enabled !== false && s.folders !== false, status: s.statusColumn === true, hide: s.hideData === true, tip: !s.foldersTipOff };
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
    if (e.source === window && e.data?.src === "phitex-folders" && e.data.tipOff === true) void chrome.storage.local.set({ foldersTipOff: true });
  });
})();
