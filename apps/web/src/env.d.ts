// The samples, imported as their text (esbuild's text loader), figures as their bytes (its binary loader).
declare module "*.tex" {
  const text: string;
  export default text;
}
declare module "*.bib" {
  const text: string;
  export default text;
}
declare module "*.pdf" {
  const bytes: Uint8Array;
  export default bytes;
}
