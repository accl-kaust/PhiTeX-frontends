// PDF pages drawn in the tab by MuPDF (PhiTeX's viewer/src/mupdf.ts; the
// `mupdf` module and its .wasm bundled in dist/mupdf/), in this thread: a
// page is the canvas with its text over it (selected, copied, found) and its
// links. The canvas is swapped in only once drawn, so a redraw never blanks
// the page.

import { platform } from "./platform.ts";
import { MupdfDoc, toCanvas } from "./vendor/viewer/mupdf.ts";
import type { PageImage } from "./vendor/viewer/types.ts";

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
