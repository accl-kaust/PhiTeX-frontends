// Where the code lives: set at build time, e.g.
//   VITE_REPO_URL=https://example.org/you/PhiTeX npm run build
// Unset, the links that need it are hidden.
export const REPO: string | undefined = import.meta.env.VITE_REPO_URL || undefined;
