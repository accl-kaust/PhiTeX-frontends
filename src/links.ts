// Where the code lives. Overridable at build time, e.g.
//   VITE_REPO_URL=https://example.org/you/PhiTeX npm run build
export const REPO: string = import.meta.env.VITE_REPO_URL || "https://github.com/accl-kaust/PhiTeX";
// The browser / VS Code extension (shares the viewer with the CLI).
export const EXT: string = import.meta.env.VITE_EXT_URL || "https://github.com/accl-kaust/PhiTeX-extension";
// Per-store listings. Default to the extension repo until the stores are live;
// set VITE_CHROME_URL / VITE_EDGE_URL / VITE_FIREFOX_URL at build time to swap.
export const STORES: Record<string, string> = {
  chrome: import.meta.env.VITE_CHROME_URL || EXT,
  edge: import.meta.env.VITE_EDGE_URL || EXT,
  firefox: import.meta.env.VITE_FIREFOX_URL || EXT,
};
