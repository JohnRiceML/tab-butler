/**
 * Goobi — the app's mascot. A coral pixel blob (the Claude "Clawd" body color),
 * extracted from the mascot lab. Renders a small, mood-driven Goobi onto a canvas:
 * he bobs/blinks when idle, naps when nothing's going on, looks around while
 * searching, beams when you reply, and goes woozy + red when you're going too fast.
 * Moods map to real app signals (see docs/goobi-design-v1.md). The heavy care/
 * animation system lives in mascot-lab.html; this is the lightweight in-app version.
 */

export type GoobiMood = "idle" | "sleeping" | "searching" | "happy" | "worn";

export interface GoobiHandle { el: HTMLCanvasElement; setMood(m: GoobiMood): void; destroy(): void; }

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

const CORAL = "rgb(215,119,87)", RED = "rgb(210,59,46)"; // Clawd coral · "unwell" red
const EYE = "#141413", HILITE = "#faf9f5", ZZZ = "#b0aea5";

const HAPPY: number[][] = [[6, 8], [7, 7], [7, 9], [6, 12], [7, 11], [7, 13]];           // ^‿^ squint
const XEYES: number[][] = [[6, 7], [6, 9], [7, 8], [8, 7], [8, 9], [6, 11], [6, 13], [7, 12], [8, 11], [8, 13]]; // dizzy
const ZLOW: number[][] = [[2, 18], [2, 19], [3, 18], [4, 18], [4, 19]];
const ZHIGH: number[][] = [[0, 17], [0, 18], [0, 19], [1, 18], [2, 17], [2, 18]];

function grid(): string[][] { return BASE.map((r) => r.split("")); }
function eyesHalf(): string[][] { const g = grid(); EYE_COLS.forEach((c) => (g[6][c] = "B")); return g; }
function eyesClosed(): string[][] { const g = grid(); EYE_COLS.forEach((c) => { g[6][c] = "B"; g[7][c] = "B"; }); return g; }
function faceWith(px: number[][]): string[][] {
  const g = grid();
  [6, 7, 8].forEach((r) => EYE_COLS.forEach((c) => (g[r][c] = "B")));
  px.forEach((p) => (g[p[0]][p[1]] = "E"));
  return g;
}
function eyesShift(d: number): string[][] {
  const px: number[][] = [];
  [6, 7, 8].forEach((r) => EYE_COLS.forEach((c) => px.push([r, c + d])));
  return faceWith(px);
}
function sleepFrame(zpx: number[][]): string[][] {
  const g = eyesClosed();
  zpx.forEach((p) => (g[p[0]][p[1]] = "Z"));
  return g;
}

function paint(ctx: CanvasRenderingContext2D, g: string[][], cell: number, body: string): void {
  ctx.clearRect(0, 0, COLS * cell, ROWS * cell);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const ch = g[r][c];
    if (ch === ".") continue;
    ctx.fillStyle = ch === "E" ? EYE : ch === "H" ? HILITE : ch === "Z" ? ZZZ : body;
    ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
  }
}

const ANIM: Record<GoobiMood, string> = { idle: "g-bob", sleeping: "g-breathe", searching: "g-bob", happy: "g-bob", worn: "g-wobble" };

/** Render a small, mood-driven Goobi into `host` (replaces its contents). Returns a
 *  handle to drive his mood. Frame loops self-stop when the canvas detaches (no leak). */
export function mountGoobi(host: HTMLElement, opts?: { cell?: number }): GoobiHandle {
  const cell = opts?.cell ?? 2;
  host.replaceChildren();
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const w = COLS * cell, h = ROWS * cell;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  host.appendChild(canvas);

  let mood: GoobiMood = "idle";
  let timer: number | undefined;
  const stop = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  const alive = () => canvas.isConnected;

  function run(m: GoobiMood): void {
    if (!ctx) return;
    mood = m;
    canvas.className = "gcv " + ANIM[m];
    stop();
    const body = m === "worn" ? RED : CORAL;
    if (m === "sleeping") {
      const frames = [sleepFrame(ZLOW), sleepFrame(ZHIGH), sleepFrame([])];
      let i = 0;
      const tick = () => { if (!alive()) return; paint(ctx, frames[i % frames.length], cell, body); i++; timer = window.setTimeout(tick, 620); };
      tick();
    } else if (m === "searching") {
      const frames = [grid(), eyesShift(1), grid(), eyesShift(-1)];
      const holds = [480, 420, 360, 420];
      let i = 0;
      const tick = () => { if (!alive()) return; paint(ctx, frames[i % frames.length], cell, body); const hold = holds[i % holds.length]; i++; timer = window.setTimeout(tick, hold); };
      tick();
    } else if (m === "happy") {
      paint(ctx, faceWith(HAPPY), cell, body); // held ^‿^ + bob (css)
    } else if (m === "worn") {
      paint(ctx, faceWith(XEYES), cell, body); // dizzy + red + wobble (css)
    } else { // idle — blink loop
      paint(ctx, grid(), cell, body);
      const blink = () => {
        if (!alive() || mood !== "idle") return;
        paint(ctx, eyesHalf(), cell, body);
        window.setTimeout(() => alive() && mood === "idle" && paint(ctx, eyesClosed(), cell, body), 70);
        window.setTimeout(() => alive() && mood === "idle" && paint(ctx, eyesHalf(), cell, body), 150);
        window.setTimeout(() => alive() && mood === "idle" && paint(ctx, grid(), cell, body), 220);
        timer = window.setTimeout(blink, 2600 + Math.random() * 2800);
      };
      timer = window.setTimeout(blink, 1800 + Math.random() * 1500);
    }
  }

  run("idle");
  return { el: canvas, setMood: (m) => { if (m !== mood) run(m); }, destroy: stop };
}
