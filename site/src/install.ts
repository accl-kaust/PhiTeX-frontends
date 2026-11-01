// /install: the binary, then each editor's setup. Shared chrome, and a Copy button on every command.
import "./style.css";
import { $$, initChrome } from "./ui.ts";

initChrome();

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
