// Where the code lives. Overridable at build time, e.g.
//   VITE_REPO_URL=https://example.org/you/PhiTeX npm run build
export const REPO: string = import.meta.env.VITE_REPO_URL || "https://github.com/accl-kaust/PhiTeX";
// The editors' code: the Overleaf and VS Code extensions, phitex.lua, phitex.el.
export const EXT: string = import.meta.env.VITE_EXT_URL || "https://github.com/accl-kaust/PhiTeX-frontends";
// The Overleaf extension's store listings (VITE_CHROME_URL / VITE_EDGE_URL / VITE_FIREFOX_URL override them).
export const STORES: Record<string, string> = {
  chrome: import.meta.env.VITE_CHROME_URL || "https://chromewebstore.google.com/detail/phitex-instant-for-overle/joimneigjammmhdbgaonlepnlllceajl",
  edge: import.meta.env.VITE_EDGE_URL || "https://microsoftedge.microsoft.com/addons/detail/phitex-instant-for-overle/gkcnpagkdjaefnnpkoogdpacdmgpihpd",
  firefox: import.meta.env.VITE_FIREFOX_URL || "https://addons.mozilla.org/en-US/firefox/addon/phitex-for-overleaf-unofficial/",
};
