// The viewer's side of an editor check (test/editors/run.sh): joins the
// watch's viewer at URL over its WebSocket, as a browser tab does, and
//   probe.mjs URL source FILE LINE   asks it to show FILE:LINE in the editor
//                                    (a double-click's inverse search)
//   probe.mjs URL follow MS          prints the first `follow` event (the
//                                    editor's cursor on the pages: forward
//                                    search) within MS, else exits 1
// Node's own WebSocket; no packages.
const [url, what, ...args] = process.argv.slice(2);
const ws = new WebSocket(url.replace(/^http/, "ws") + "ws");
await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)));
if (what === "source") {
  ws.send(JSON.stringify({ id: 1, op: "source", file: args[0], line: Number(args[1]), col: 1 }));
  await new Promise((ok) => (ws.onmessage = (m) => JSON.parse(m.data).id === 1 && ok()));
  console.log("asked");
  process.exit(0);
}
if (what === "follow") {
  const t = setTimeout(() => (console.log("no follow"), process.exit(1)), Number(args[0] ?? 20000));
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.event === "follow") (clearTimeout(t), console.log(JSON.stringify(e)), process.exit(0));
  };
}
