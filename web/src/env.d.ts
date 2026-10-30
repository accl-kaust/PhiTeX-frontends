// The samples, imported as their text (esbuild's text loader).
declare module "*.tex" {
  const text: string;
  export default text;
}
