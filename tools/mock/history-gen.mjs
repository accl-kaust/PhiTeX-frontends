// A project's history for the mock Overleaf (tools/mock/server.mjs), made
// change by change as Overleaf's history-v1 keeps it (`/changes`: each
// change's operations, its v2Authors, its timestamp), with what each
// character of the final text was typed by worked out here on its own, by
// a plain simulation (an array of characters, each with its change), not by
// the extension's replay: the truth an exact blame must give.
//
// The history: Ali's first draft, then edit sessions by Ali, Lina and Mary
// (more than 600 of them), each replacing a word inside a line someone
// else wrote, adding a sentence, deleting one, a session with two people's
// changes, one changing spacing only, a sentence moved to another
// paragraph, and a label ("Submitted v1") part way.
//
//   node tools/mock/history-gen.mjs DIR [SESSIONS]
//   → DIR/main.tex (the project as the editor has it) and DIR.history.json
//     ({users, changes, sessions, labels, blobs, truth}); the scenario's
//     "history" names the JSON, its "project" the folder.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = process.argv[2];
const SESSIONS = Number(process.argv[3] ?? 650);
if (!dir) throw new Error("usage: history-gen.mjs DIR [SESSIONS]");

// (a fixed sequence: the same history every run)
let seed = 20261119;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rand() * a.length)];

const users = {
  ali: { id: "5f00000000000000000a1101", first_name: "Ali", last_name: "Rahman", email: "ali@example.org" },
  lina: { id: "5f00000000000000000a1102", first_name: "Lina", last_name: "Chen", email: "lina@example.org" },
  mary: { id: "5f00000000000000000a1103", first_name: "Mary", last_name: "Okafor", email: "mary@example.org" },
};
const WORDS = "graph paragraph typesetter edit keystroke latency page output byte identical change history version author line word sentence figure table result method claim measure document chapter reader writer".split(" ");
const sentence = () => {
  const n = 6 + Math.floor(rand() * 6);
  const w = Array.from({ length: n }, () => pick(WORDS));
  return w[0][0].toUpperCase() + w[0].slice(1) + " " + w.slice(1).join(" ") + ".";
};

/** The file: its characters, each with the change that typed it (the truth). */
let doc = [];
const text = () => doc.map((c) => c.ch).join("");
const changes = [];
const sessions = [];
const blobs = {};
const DAY = 86400e3;
const t0 = Date.parse("2026-07-01T09:00:00Z");
let now = t0;

/** A change: `ops` (a text operation on the text as it is) by `who` at `at`, applied to the truth by `apply`. */
function change(who, at, operations) {
  changes.push({ operations, timestamp: new Date(at).toISOString(), authors: [], v2Authors: [users[who].id], projectVersion: `${changes.length + 1}.0` });
}

/** An edit of the text: [from, to) replaced by `ins` (characters moved keep their change), as one text operation. */
function edit(who, at, from, to, ins) {
  const v = changes.length;
  const len = doc.length;
  const s = typeof ins === "string" ? ins : ins.map((c) => c.ch).join("");
  const op = [];
  if (from) op.push(from);
  if (to > from) op.push(-(to - from));
  if (s) op.push(s);
  if (len - to) op.push(len - to);
  change(who, at, [{ pathname: "main.tex", textOperation: op }]);
  const chars = typeof ins === "string" ? [...ins].map((ch) => ({ ch, v })) : ins;
  doc.splice(from, to - from, ...chars);
}

/** A move: [from, to) cut and put at `at` (an offset in the text without it), one operation, its characters keeping their change. */
function move(who, t, from, to, at) {
  const v = changes.length;
  const len = doc.length;
  const cut = doc.slice(from, to);
  const s = cut.map((c) => c.ch).join("");
  const op = [];
  // (in the text as it was: the insertion before the cut, or after it)
  if (at <= from) {
    if (at) op.push(at);
    op.push(s);
    if (from - at) op.push(from - at);
    op.push(-(to - from));
    if (len - to) op.push(len - to);
  } else {
    const at0 = at + (to - from);
    if (from) op.push(from);
    op.push(-(to - from));
    if (at0 - to) op.push(at0 - to);
    op.push(s);
    if (len - at0) op.push(len - at0);
  }
  change(who, t, [{ pathname: "main.tex", textOperation: op }]);
  doc.splice(from, to - from);
  doc.splice(at, 0, ...cut);
  void v;
}

// (the first draft: the file added whole, its text a blob)
const first = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
${Array.from({ length: 4 }, sentence).join(" ")}

${Array.from({ length: 4 }, sentence).join(" ")}

\\section{Results}
${Array.from({ length: 4 }, sentence).join(" ")}

${Array.from({ length: 3 }, sentence).join(" ")}
\\end{document}
`;
const hash = crypto.createHash("sha1").update(`blob ${Buffer.byteLength(first)}\0${first}`).digest("hex");
blobs[hash] = first;
change("ali", now, [{ pathname: "main.tex", file: { hash, stringLength: first.length } }]);
doc = [...first].map((ch) => ({ ch, v: 0 }));
sessions.push({ fromV: 0, toV: 1, who: ["ali"], start: now, end: now });

/** The paragraphs' lines: [start, end) of each line of body text. */
const lines = () => {
  const t = text();
  const out = [];
  let a = 0;
  for (const l of t.split("\n")) {
    if (l && !l.startsWith("\\")) out.push([a, a + l.length]);
    a += l.length + 1;
  }
  return out;
};
const wordsIn = ([a, b]) => {
  const t = text().slice(a, b);
  return [...t.matchAll(/[A-Za-z]+/g)].map((m) => [a + m.index, a + m.index + m[0].length]);
};

const who3 = ["ali", "lina", "mary"];
const labels = [];
for (let s = 1; s < SESSIONS; s++) {
  now += 3 * 3600e3 + Math.floor(rand() * 3600e3);
  const fromV = changes.length;
  const who = who3[s % 3];
  const start = now;
  const kind = s === 200 ? "delete" : s === 300 ? "spacing" : s === 420 ? "move" : s % 97 === 0 ? "pair" : s % 7 === 0 ? "sentence" : "word";
  const ls = lines();
  if (kind === "word" || kind === "pair") {
    // (a word replaced inside a line, likely another's)
    const l = pick(ls);
    const [a, b] = pick(wordsIn(l));
    let w = pick(WORDS);
    if (w === text().slice(a, b)) w = w + "s";
    edit(who, now, a, b, w);
    if (kind === "pair") {
      // (a second person in the same session, a minute later, a word of the same line)
      const other = who3[(s + 1) % 3];
      now += 60e3;
      const [a2, b2] = pick(wordsIn(lines().find((x) => x[0] === l[0]) ?? l));
      edit(other, now, a2, b2, pick(WORDS));
      sessions.push({ fromV, toV: changes.length, who: [who, other], start, end: now });
      continue;
    }
    // (two changes in a session now and then: the same person, a few seconds apart)
    if (s % 5 === 0) {
      now += 5e3;
      const l2 = pick(lines());
      const [a2, b2] = pick(wordsIn(l2));
      edit(who, now, a2, b2, pick(WORDS));
    }
  } else if (kind === "sentence") {
    const l = pick(ls);
    edit(who, now, l[1], l[1], " " + sentence());
  } else if (kind === "delete") {
    // (a sentence deleted: its characters gone from the text)
    const l = ls[1];
    const t = text().slice(l[0], l[1]);
    const end = t.indexOf(". ") + 2;
    edit(who, now, l[0], l[0] + end, "");
  } else if (kind === "spacing") {
    // (spacing only: a space doubled)
    const l = pick(ls);
    const t = text().slice(l[0], l[1]);
    const k = l[0] + t.indexOf(" ");
    edit(who, now, k, k, " ");
  } else if (kind === "move") {
    // (a sentence moved to another paragraph: its characters keep their writers)
    const a = ls[2];
    const t = text().slice(a[0], a[1]);
    const end = a[0] + t.indexOf(". ") + 2;
    // (to the end of the first paragraph, before it in the text: its place the same without the cut)
    move(who, now, a[0], end, ls[0][1]);
  }
  sessions.push({ fromV, toV: changes.length, who: [who], start, end: now });
  if (s === 330) labels.push({ comment: "Submitted v1", version: changes.length, at: now });
}

// (the operations replayed on plain text give the same text: the history is self-consistent)
{
  let t = "";
  for (const c of changes)
    for (const op of c.operations) {
      if (op.file) t = blobs[op.file.hash];
      if (!op.textOperation) continue;
      let at = 0, out = "";
      for (const x of op.textOperation) {
        if (typeof x === "string") out += x;
        else if (x > 0) (out += t.slice(at, at + x)), (at += x);
        else at -= x;
      }
      if (at !== t.length) throw new Error(`an operation of length ${at} on a text of ${t.length}`);
      t = out;
    }
  if (t !== text()) throw new Error("the operations do not make the text");
}

// (the truth: each character's change, as runs over the final text in UTF-16 units)
const truth = [];
doc.forEach((c, i) => {
  const r = truth.at(-1);
  if (r && r[2] === c.v && r[1] === i) r[1] = i + 1;
  else truth.push([i, i + 1, c.v]);
});
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "main.tex"), text());
fs.writeFileSync(`${dir}.history.json`, JSON.stringify({ users, changes, sessions, labels, blobs, truth: { "main.tex": truth }, end: now }));
console.log(`${changes.length} changes in ${sessions.length} sessions, ${text().length} characters; ${dir}/main.tex, ${dir}.history.json`);
