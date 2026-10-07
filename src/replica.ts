// The editable demo: an editor with an instant preview (DESIGN MOCK: fake.ts).
// Mounts wherever the `#src` editor is present — the neutral editor on the home
// page, and the Overleaf-skinned replica on /overleaf. Same engine, same ids.
import { PRESETS } from "./demo/presets.ts";
import { blockAt, highlight, typeset } from "./fake.ts";
import { $, $$, reduced, sleep } from "./ui.ts";

export function initReplica() {
  const src = $<HTMLTextAreaElement>("#src");
  if (!src) return;

  // The Overleaf skin carries the PDF | ⚡ Instant switch and Recompile
  // button; the home editor is always-live and has neither.
  const ol = src.closest(".replica")?.classList.contains("ol") ?? false;
  const hl = $("#hl");
  const gutter = $("#gutter");
  const page = $("#r-page");
  const pdfPane = $(".r-pdf");
  const sw = document.querySelector<HTMLElement>("#r-switch");
  const rec = document.querySelector<HTMLElement>("#r-recompile");
  let preset = PRESETS[0];
  let prev = "";
  let hot = -1;
  let hotTimer = 0;
  let instant = false;
  let stale = false;

  function paintEditor() {
    hl.innerHTML = highlight(src.value, instant ? hot : -1);
    gutter.textContent = Array.from({ length: src.value.split("\n").length }, (_, i) => i + 1).join("\n");
    src.style.height = hl.offsetHeight + "px";
  }

  function render(changedAt?: number) {
    const t0 = performance.now();
    const t = typeset(src.value, { runhead: preset.id === "book" });
    page.innerHTML = t.html;
    if (changedAt !== undefined) {
      hot = blockAt(src.value, changedAt);
      page.querySelector(`.ch[data-b="${hot}"]`)?.classList.add("hot");
      clearTimeout(hotTimer);
      hotTimer = window.setTimeout(() => {
        page.querySelectorAll(".ch.hot").forEach((e) => e.classList.remove("hot"));
        hot = -1;
        paintEditor();
      }, 700);
    }
    $("#s-chunks").textContent = `${changedAt === undefined ? 0 : 1} of ${t.chunks.toLocaleString()}`;
    requestAnimationFrame(() => {
      if (changedAt !== undefined) $("#lat").textContent = Math.max(1, performance.now() - t0).toFixed(0);
    });
  }

  function setInstant(on: boolean) {
    instant = on;
    sw?.classList.toggle("inst", on);
    sw?.setAttribute("aria-checked", String(on));
    pdfPane.classList.toggle("instant", on);
    rec?.classList.toggle("off", on);
    if (on && stale) recompile();
  }
  function setStale(on: boolean) {
    stale = on;
    pdfPane.classList.toggle("stale", on);
    rec?.classList.toggle("nag", on);
  }
  function recompile() {
    setStale(false);
    render();
  }

  function load(id: string) {
    preset = PRESETS.find((p) => p.id === id)!;
    src.value = preset.files[preset.open];
    prev = src.value;
    $("#r-tab").textContent = $(`.r-file[data-preset="${id}"]`).firstChild!.textContent!.trim();
    $("#editor").scrollTop = 0;
    setStale(false);
    render();
    paintEditor();
    $$(".r-file[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === id));
  }

  let userTyped = false;
  src.addEventListener("input", () => {
    const now = src.value;
    let a = 0;
    while (a < prev.length && a < now.length && prev[a] === now[a]) a++;
    prev = now;
    if (instant) render(a);
    else setStale(true);
    paintEditor();
  });
  let autoDirty = false;
  const takeOver = () => {
    if (userTyped) return;
    userTyped = true;
    // (the auto-typing stops mid-word: give the reader the example as it was)
    if (autoDirty) {
      src.value = preset.files[preset.open];
      prev = src.value;
      render();
      paintEditor();
    }
    setInstant(true);
  };
  src.addEventListener("keydown", takeOver);
  src.addEventListener("pointerdown", takeOver);
  sw?.addEventListener("click", () => {
    userTyped = true;
    setInstant(!instant);
  });
  rec?.addEventListener("click", recompile);
  $$(".r-file[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      userTyped = true;
      load(b.dataset.preset!);
    }),
  );
  load(document.querySelector<HTMLElement>(".r-file[data-preset].on")?.dataset.preset ?? "article");
  // The home editor is live from the first paint; Overleaf starts on Recompile.
  if (!ol) setInstant(true);

  const type = async (text: string) => {
    const at = () => src.value.indexOf("Everything on the page");
    for (const ch of text) {
      if (userTyped) return false;
      const pos = at();
      src.value = src.value.slice(0, pos) + ch + src.value.slice(pos);
      autoDirty = true;
      src.dispatchEvent(new Event("input"));
      await sleep(50 + Math.random() * 80);
    }
    return true;
  };

  async function autotype() {
    if (reduced.matches) return setInstant(true);
    if (!ol) {
      // home: already live — just show a keystroke landing on the page.
      await sleep(1600);
      await type("Edit anything, and the page keeps up. ");
      return;
    }
    // Overleaf: type in PDF mode (stale), flip to Instant, type on.
    await sleep(1400);
    if (!(await type("With Recompile, "))) return;
    await sleep(1200);
    if (userTyped) return;
    setInstant(true);
    await sleep(900);
    if (!(await type("but not with PhiTeX. "))) return;
  }
  autotype();
}
