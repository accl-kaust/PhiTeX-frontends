// The folders' content script (page world, from the page's start; bundled
// to dist/folders.js): on the project dashboard (/project, /project/owned,
// /project/tags/<id>, ...), not in the editor (/project/<24 hex id>).
//
// Its settings are the extension's (the popup's, chrome.storage), which the
// page's world can't read: dashboard.ts, in the content scripts' world,
// keeps a copy in the page's localStorage, read here at once (the rows
// hidden from React's first render), and posts each change; and is asked
// here to save the tip turned off.

import { folderConsent, folderTip, searchTip } from "./intro.ts";
import { mount } from "./ui.ts";

/** As dashboard.ts writes it. */
type Settings = { on: boolean; status: boolean; hide: boolean; tip: boolean; searchTip: boolean };
const KEY = "phitex:dashboard";

/** The defaults, as the popup's. */
const DEFAULTS: Settings = { on: true, status: false, hide: false, tip: true, searchTip: true };

function stored(): Settings {
  // (a copy from an older version lacks the newer settings: theirs the defaults)
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

if (!/^\/project\/([0-9a-f]{24}|mock)/.test(location.pathname)) {
  let now = stored();
  let unmount: (() => void) | null = null;
  const start = () => {
    unmount?.();
    unmount = now.on
      ? mount({
          ask: folderConsent,
          status: now.status,
          hideStorage: now.hide,
          drawn: (v) => {
            if (now.tip) folderTip(v, () => window.postMessage({ src: "phitex-folders", tipOff: true }, location.origin));
            if (now.searchTip) searchTip(v, () => window.postMessage({ src: "phitex-folders", searchTipSeen: true }, location.origin));
          },
        })
      : null;
  };
  start();
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.src !== "phitex-dashboard") return;
    const s = { ...DEFAULTS, ...(e.data.settings as Partial<Settings>) };
    const again = s.on !== now.on || s.status !== now.status || s.hide !== now.hide;
    now = s;
    if (again) start();
  });
}
