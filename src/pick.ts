import "./style.css";
// Logo 4: a Φ drawn as a grid of chunks, one lit.
const map = [
  "....###....",
  ".....#.....",
  "..#######..",
  ".##..#..##.",
  "##...#...##",
  "##...#...##",
  "##...#...##",
  ".##..#..##.",
  "..#######..",
  ".....#.....",
  "....###....",
];
const s = 12, g = 1.6;
let out = "";
map.forEach((row, y) => [...row].forEach((c, x) => {
  if (c !== "#") return;
  const lit = x === 8 && y === 3;
  out += `<rect x="${x * s + 9}" y="${y * s + 24}" width="${s - g}" height="${s - g}" fill="${lit ? "var(--accent)" : "var(--text)"}"/>`;
}));
document.querySelector("#chunky")!.innerHTML = out;
