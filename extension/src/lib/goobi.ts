/**
 * Goobi — the app's mascot. A coral pixel blob (the Claude "Clawd" body color),
 * extracted from the mascot lab. This module renders a small, idle-bobbing,
 * blinking Goobi onto a canvas for the side-panel header (and anywhere else we
 * want his face). The full care/animation system lives in mascot-lab.html; this
 * is the lightweight "alive in the header" version.
 */

// 20×14 pixel grid. '.' transparent · 'B' body · 'E' eye · 'H' eye highlight.
const BASE = [
  "......BBBBBBBBB......",
  ".....BBBBBBBBBBB.....",
  "....BBBBBBBBBBBBB....",
  "...BBBBBBBBBBBBBBB...",
  "...BBBBBBBBBBBBBBB...",
  "...BBBBBBBBBBBBBBB...",
  "...BBBBEHBBBHEBBBB...",
  "...BBBBEEBBBEEBBBB...",
  "...BBBBEEBBBEEBBBB...",
  "...BBBBBBBBBBBBBBB...",
  "...BBBBBBBBBBBBBBB...",
  "....BBBBBBBBBBBBB....",
  ".....BBB.....BBB.....",
  ".....BBB.....BBB.....",
];
const COLS = BASE[0].length, ROWS = BASE.length;
const EYE_COLS = [7, 8, 12, 13];

const CORAL = "rgb(215,119,87)"; // the exact Claude Code "Clawd" body color
const EYE = "#141413", HILITE = "#faf9f5";

function grid(): string[][] { return BASE.map((r) => r.split("")); }
function eyesHalf(): string[][] { const g = grid(); EYE_COLS.forEach((c) => (g[6][c] = "B")); return g; }
function eyesClosed(): string[][] { const g = grid(); EYE_COLS.forEach((c) => { g[6][c] = "B"; g[7][c] = "B"; }); return g; }

function paint(ctx: CanvasRenderingContext2D, g: string[][], cell: number): void {
  ctx.clearRect(0, 0, COLS * cell, ROWS * cell);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const ch = g[r][c];
    if (ch === ".") continue;
    ctx.fillStyle = ch === "E" ? EYE : ch === "H" ? HILITE : CORAL;
    ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5); // +0.5 closes hairline seams
  }
}

/** Render a small, idle Goobi into `host` (replaces its contents). He bobs (via
 *  CSS, class `goobi-canvas`) and blinks on a relaxed random timer. The blink loop
 *  stops itself once the canvas is detached (e.g. a re-render), so it never leaks. */
export function mountGoobi(host: HTMLElement, cell = 2): void {
  host.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.className = "goobi-canvas";
  const dpr = window.devicePixelRatio || 1;
  const w = COLS * cell, h = ROWS * cell;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  host.appendChild(canvas);
  paint(ctx, grid(), cell);

  const open = () => { if (canvas.isConnected) paint(ctx, grid(), cell); };
  const blink = () => {
    if (!canvas.isConnected) return; // re-rendered away — stop the loop (no leak)
    paint(ctx, eyesHalf(), cell);
    setTimeout(() => canvas.isConnected && paint(ctx, eyesClosed(), cell), 70);
    setTimeout(() => canvas.isConnected && paint(ctx, eyesHalf(), cell), 150);
    setTimeout(open, 220);
    setTimeout(blink, 2600 + Math.random() * 2800);
  };
  setTimeout(blink, 1800 + Math.random() * 1500);
}
