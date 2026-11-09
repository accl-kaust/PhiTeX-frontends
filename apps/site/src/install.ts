// /install: the binary, then each editor's setup. Shared chrome, and a Copy button on every command.
import "./style.css";
import { $$, initChrome } from "./ui.ts";
import { REPO } from "./links.ts";

initChrome();

// (Windows: shown once a release carries its build, the deploy's check:
// VITE_WINDOWS. Then the tabs, Windows first on a Windows machine)
if (import.meta.env.VITE_WINDOWS === "1") {
  $$("[data-nowin]").forEach((e) => e.remove());
  $$<HTMLAnchorElement>("[data-winzip]").forEach((a) => (a.href = `${REPO}/releases/latest/download/phitex-${a.dataset.winzip}-windows.zip`));
  const tabs = $$<HTMLButtonElement>(".os-tabs [role=tab]");
  const show = (os: string) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.os === os)));
    $$<HTMLElement>(".os-panel, [data-os-only]").forEach((p) => (p.hidden = (p.dataset.os ?? p.dataset.osOnly) !== os));
  };
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.os!)));
  $$(".os-tabs").forEach((e) => e.removeAttribute("hidden"));
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  show(/^win/i.test(platform) || /\bWindows\b/.test(navigator.userAgent) ? "windows" : "unix");
}

$$<HTMLButtonElement>(".cmd .copy").forEach((b) =>
  b.addEventListener("click", async () => {
    // (a command's comments, after "#" or ";", are for reading)
    const text = b.previousElementSibling!.textContent!.split("\n").map((l) => l.replace(/\s{2,}[#;].*$/, "")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Select it";
    }
    setTimeout(() => (b.textContent = "Copy"), 1600);
  }),
);
