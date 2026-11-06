// The status bar's PhiTeX item: what the engine is doing, always true to
// it. Idle, "⚡ PhiTeX" (a click: the menu); while it builds, a spinner and
// the step (starting, fetching a package, making the format, typesetting); built, the last
// build's time and its problems; a crash, in the error colour. Its state is
// phitex/status's (docs/spec-editor-protocol.md: the language server's,
// native or wasm); the builtin engine's events say the same meanwhile.

import * as vscode from "vscode";

export type EngineState = "off" | "starting" | "fetching" | "format" | "typesetting" | "ready" | "failed" | "stopped" | "crashed";

/** As phitex/status says it. */
export type EngineStatus = {
  state: EngineState;
  engine?: "native" | "wasm";
  /** The last build's time. */
  ms?: number;
  pages?: number;
  errors?: number;
  warnings?: number;
  /** The package being fetched, or the page being typeset. */
  name?: string;
};

export class StatusItem implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem("phitex.status", vscode.StatusBarAlignment.Left, 100);
  private now: EngineStatus = { state: "off" };

  constructor() {
    this.item.name = "PhiTeX";
    this.item.command = "phitex.menu";
    this.draw();
    this.item.show();
  }

  get state(): EngineState {
    return this.now.state;
  }

  /** A new status; what it leaves out kept from the last (a step keeps the last build's numbers). */
  set(s: Partial<EngineStatus> & { state: EngineState }): void {
    this.now = s.state === "off" ? { state: "off" } : { ...this.now, ...s };
    this.draw();
  }

  /** The builtin engine's events (the viewer's, common/src/viewer/session.ts's CoreEvent), as phitex/status would say them. */
  event(e: { event: string; [k: string]: unknown }): void {
    if (e.event === "progress") this.set(e.phase === "fetching" ? { state: "fetching", name: String(e.name ?? e.pack ?? "") } : e.phase === "format" ? { state: "format" } : { state: "typesetting", pages: Number(e.pages ?? 0) || undefined });
    else if (e.event === "preparing" && e.on) this.set({ state: "typesetting" });
    else if (e.event === "build" || e.event === "failed") {
      const errors = Array.isArray(e.errors) ? e.errors.length : e.event === "failed" ? 1 : 0;
      this.set({ state: e.event === "failed" || !e.pages ? "failed" : "ready", ms: Number(e.wall_ms ?? 0) || undefined, pages: Number(e.pages ?? 0), errors });
    }
  }

  private draw(): void {
    const s = this.now;
    const it = this.item;
    const engine = s.engine === "native" ? "phitex watch (native)" : s.engine === "wasm" ? "builtin (WebAssembly)" : "";
    const problems = `${s.errors ? ` $(error) ${s.errors}` : ""}${s.warnings ? ` $(warning) ${s.warnings}` : ""}`;
    it.backgroundColor = s.state === "crashed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : s.state === "failed" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    switch (s.state) {
      case "off":
        it.text = "$(zap) PhiTeX";
        it.tooltip = "PhiTeX: not running. Click for the menu, or Ctrl+Alt+P to open the preview.";
        break;
      case "starting":
        it.text = "$(loading~spin) PhiTeX";
        it.tooltip = `PhiTeX: starting${engine ? ` (${engine})` : ""}`;
        break;
      case "fetching":
        it.text = `$(loading~spin) PhiTeX: ${s.name || "packages"}`;
        it.tooltip = `PhiTeX: fetching ${s.name || "packages"} (kept for next time)`;
        break;
      case "format":
        it.text = "$(loading~spin) PhiTeX: format";
        it.tooltip = "PhiTeX: making the format, once per PhiTeX update";
        break;
      case "typesetting":
        it.text = `$(loading~spin) PhiTeX${s.pages ? `: p. ${s.pages}` : ""}`;
        it.tooltip = "PhiTeX: typesetting";
        break;
      case "ready":
        it.text = `$(zap) ${s.ms !== undefined ? `${Math.round(s.ms)} ms` : "PhiTeX"}${problems}`;
        it.tooltip = `PhiTeX: built${s.ms !== undefined ? ` in ${Math.round(s.ms)} ms` : ""}, ${s.pages ?? 0} page${s.pages === 1 ? "" : "s"}${engine ? ` · ${engine}` : ""}. Click for the menu.`;
        break;
      case "failed":
        it.text = `$(error) PhiTeX${problems || " failed"}`;
        it.tooltip = "PhiTeX: the build stopped (its problems are in the preview). Click for the menu.";
        break;
      case "stopped":
        it.text = "$(zap) PhiTeX";
        it.tooltip = "PhiTeX: stopped. Click for the menu, or Ctrl+Alt+P to open the preview.";
        break;
      case "crashed":
        it.text = "$(warning) PhiTeX exited";
        it.tooltip = "PhiTeX: the engine exited. Click to restart it or see its log.";
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
