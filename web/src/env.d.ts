// The demo's imports esbuild resolves itself: the samples as text, the mock's editor (JavaScript).
declare module "*.tex" {
  const text: string;
  export default text;
}
declare module "../../mock/editor/editor.mjs" {
  export const EditorState: any;
  export const EditorView: any;
  export function extensions(onUpdate: (u: any) => void): any[];
}
