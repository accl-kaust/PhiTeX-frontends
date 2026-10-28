// phitex watch --lsp as VS Code's native engine drives it (vscode/src/
// extension.ts): the viewer's address in a logMessage, an unsaved edit's
// error as a diagnostic, its fix clearing it, the cursor told, a clean end.
//
//   scripts/sandbox node test/lsp-smoke.mjs PHITEX DIR MAIN.tex

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as rpc from "../vscode/node_modules/vscode-jsonrpc/node.js";

const [bin, dir, main] = process.argv.slice(2);
const p = spawn(bin, ["watch", main, "--lsp"], { cwd: dir });
p.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
const c = rpc.createMessageConnection(new rpc.StreamMessageReader(p.stdout), new rpc.StreamMessageWriter(p.stdin));
const t0 = performance.now();
const at = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
let url;
const diags = [];
let waiter = () => {};
c.onNotification("window/logMessage", (m) => { const u = m.message.match(/http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\//); if (u && !url) { url = u[0]; console.log(`${at()} viewer at ${url}`); } });
c.onNotification("textDocument/publishDiagnostics", (d) => { diags.push(d); waiter(); });
c.onNotification(() => {});
c.onRequest("window/workDoneProgress/create", () => null);
c.onRequest("window/showDocument", (r) => (console.log("showDocument", JSON.stringify(r)), { success: true }));
c.listen();
const uri = pathToFileURL(`${dir}/${main}`).toString();
const until = (f, ms = 120000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms); waiter = () => { if (f()) { clearTimeout(t); res(); } }; waiter(); });
const init = await c.sendRequest("initialize", { processId: process.pid, rootUri: pathToFileURL(dir).toString(), capabilities: { window: { showDocument: { support: true }, workDoneProgress: true }, general: { positionEncodings: ["utf-16"] } } });
console.log(`${at()} initialize: ${JSON.stringify(init.capabilities.positionEncoding)}, sync ${JSON.stringify(init.capabilities.textDocumentSync)}`);
c.sendNotification("initialized", {});
const text = readFileSync(`${dir}/${main}`, "utf8");
c.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "latex", version: 1, text } });
await until(() => diags.some((d) => d.uri === uri));
console.log(`${at()} first build: ${diags.at(-1).diagnostics.length} diagnostics`);
// (the viewer's connection, as its page makes it: the events after a build)
const events = [];
const ws = new WebSocket(new URL("ws", url).toString().replace(/^http/, "ws"));
ws.onmessage = (m) => { const r = JSON.parse(m.data); if (r.event) events.push(r); };
await new Promise((r) => (ws.onopen = r));
const pdf = async () => new Uint8Array(await (await fetch(new URL("doc.pdf", url))).arrayBuffer());
const before = await pdf();
const at0 = text.split("\n").findIndex((l) => l.includes("Some text"));
c.sendNotification("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: at0, character: 0 }, end: { line: at0, character: 0 } }, text: "Typed words. " }] });
for (let i = 0; i < 50 && !events.some((e) => e.event === "settled"); i++) await new Promise((r) => setTimeout(r, 100));
const after = await pdf();
console.log(`${at()} viewer events after an unsaved edit: ${JSON.stringify(events.map((e) => e.event))}; doc.pdf ${before.length} -> ${after.length} bytes, ${Buffer.compare(Buffer.from(before), Buffer.from(after)) === 0 ? "UNCHANGED" : "changed"}`);
c.sendNotification("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ range: { start: { line: at0, character: 0 }, end: { line: at0, character: 13 } }, text: "" }] });
await new Promise((r) => setTimeout(r, 500));

// (an unsaved edit with an error, then its fix)
const line = text.split("\n").findIndex((l) => l.includes("Some text"));
const n0 = diags.length;
c.sendNotification("textDocument/didChange", { textDocument: { uri, version: 4 }, contentChanges: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, text: "\\undefinedmacro " }] });
await until(() => diags.length > n0 && diags.at(-1).uri === uri && diags.at(-1).diagnostics.length > 0);
const d = diags.at(-1).diagnostics[0];
console.log(`${at()} error: line ${d.range.start.line + 1}: ${d.message.split("\n")[0]}`);
const n1 = diags.length;
c.sendNotification("textDocument/didChange", { textDocument: { uri, version: 5 }, contentChanges: [{ range: { start: { line, character: 0 }, end: { line, character: 16 } }, text: "" }] });
await until(() => diags.length > n1 && diags.at(-1).uri === uri && diags.at(-1).diagnostics.length === 0);
console.log(`${at()} fixed: diagnostics cleared`);
c.sendNotification("phitex/cursor", { textDocument: { uri }, position: { line, character: 3 } });
await new Promise((r) => setTimeout(r, 500));
await c.sendRequest("shutdown");
c.sendNotification("exit");
const code = await new Promise((r) => p.on("exit", r));
console.log(`${at()} exit ${code}; viewer announced: ${!!url}`);
process.exit(url && code === 0 ? 0 : 1);
