// Chrome's service worker: the background (background.ts) and the store's
// update, checked when Shelf asks for a newer extension (the tab's
// "update-check"). Firefox updates add-ons by itself and has no such call:
// its package leaves this file out (tools/build/package.sh).

import "./background.ts";

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "update-check") void chrome.runtime.requestUpdateCheck().catch(() => undefined);
});
