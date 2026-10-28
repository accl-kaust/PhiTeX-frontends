// PDF pages drawn in the tab by MuPDF (PhiTeX's viewer/src/mupdf.ts; the
// `mupdf` module and its .wasm bundled in dist/mupdf/), in this thread: a
// page is the canvas with its text over it (selected, copied, found) and its
// links. The canvas is swapped in only once drawn, so a redraw never blanks
// the page. Where the page's policy forbids WebAssembly (overleaf.com: no
// 'wasm-unsafe-eval', which content scripts inherit), the page is drawn
// elsewhere (the Overleaf extension's core worker) and shown here from its
// image (`pageOf`), with the same text layer.

import { platform } from "./platform.ts";
import { MupdfDoc, toCanvas, type Drawn, type Hit } from "./viewer/mupdf.ts";
import type { PageImage } from "./viewer/types.ts";
import type { Entry } from "./viewer/outline.ts";

let lib: Promise<any> | undefined;
const mupdf = () => (lib ??= import(platform().assetUrl("dist/mupdf/mupdf.js")));

/** Documents by the worker's key for their bytes: the last two. */
const docs = new Map<string, MupdfDoc>();

/**
 * Page `page` of the PDF under `key` (given as `pdf` when new) drawn at
 * `scale` device pixels per PDF point; null: no such page.
 */
export async function drawPage(key: string, page: number, scale: number, pdf?: Uint8Array): Promise<PageImage | null> {
  const m = await mupdf();
  if (pdf) {
    docs.get(key)?.destroy();
    docs.set(key, new MupdfDoc(m, pdf));
    while (docs.size > 2) {
      const [old, d] = docs.entries().next().value!;
      docs.delete(old);
      d.destroy();
    }
  }
  const d = docs.get(key)?.draw(page, scale);
  return d ? { canvas: toCanvas(d), w: d.w, h: d.h, links: d.links } : null;
}

/** Where `q` is in the PDF under `key` (MuPDF's text, every page). */
export function findIn(key: string, q: string): Hit[] {
  return docs.get(key)?.search(q) ?? [];
}

/** The PDF under `key`'s outline (its bookmarks). */
export function outlineOf(key: string): Entry[] {
  return docs.get(key)?.outline() ?? [];
}

/** A page drawn elsewhere: `Drawn` less its pixels. */
export type Shown = Omit<Drawn, "rgba">;

/**
 * The page `d` as toCanvas makes it (its canvas, its text over it), its
 * picture `image` (an encoded image of `d.pw` by `d.ph` pixels, drawn by
 * another thread): toCanvas's text layer, its canvas then given the picture.
 */
export async function pageOf(d: Shown, image: Uint8Array): Promise<PageImage> {
  const bmp = await createImageBitmap(new Blob([image as BlobPart]));
  const el = toCanvas({ ...d, rgba: new Uint8ClampedArray(4), pw: 1, ph: 1 });
  const c = el.querySelector("canvas")!;
  [c.width, c.height] = [d.pw, d.ph];
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return { canvas: el, w: d.w, h: d.h, links: d.links };
}
