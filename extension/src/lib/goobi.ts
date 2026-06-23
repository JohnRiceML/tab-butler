/**
 * Goobi — the app's mascot. A coral pixel blob (the Claude "Clawd" body color),
 * extracted from the mascot lab. Renders a small, mood-driven Goobi onto a canvas:
 * he bobs/blinks when idle, naps when nothing's going on, looks around while
 * searching, beams when you reply, and goes woozy + red when you're going too fast.
 * Moods map to real app signals (see docs/goobi-design-v1.md). The heavy care/
 * animation system lives in mascot-lab.html; this is the lightweight in-app version.
 */

export type GoobiMood = "idle" | "sleeping" | "searching" | "thinking" | "happy" | "worn" | "cheer" | "love";

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
const EYE = "#141413", HILITE = "#faf9f5", ZZZ = "#b0aea5", LOVE_RED = "#d23b2e";

const HAPPY: number[][] = [[6, 8], [7, 7], [7, 9], [6, 12], [7, 11], [7, 13]];           // ^‿^ squint
const XEYES: number[][] = [[6, 7], [6, 9], [7, 8], [8, 7], [8, 9], [6, 11], [6, 13], [7, 12], [8, 11], [8, 13]]; // dizzy
const LOVE: number[][] = [[6, 7], [6, 9], [7, 7], [7, 8], [7, 9], [8, 8], [6, 11], [6, 13], [7, 11], [7, 12], [7, 13], [8, 12]]; // heart eyes
const ZLOW: number[][] = [[3, 18], [3, 19], [4, 18]];                                            // small z, low
const ZHIGH: number[][] = [[1, 18], [1, 19], [2, 18], [3, 17], [3, 18], [3, 19]];                // medium z, higher
const ZBIG: number[][] = [[0, 17], [0, 18], [0, 19], [1, 18], [1, 19], [2, 17], [2, 18], [2, 19]]; // big z, highest

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
function eyesUp(d = 0): string[][] { // glancing up (optionally shifted) — concentrating
  const px: number[][] = [];
  [5, 6, 7].forEach((r) => EYE_COLS.forEach((c) => px.push([r, c + d])));
  return faceWith(px);
}
function winkRight(): string[][] { const g = grid(); [12, 13].forEach((c) => { g[6][c] = "B"; g[7][c] = "B"; }); return g; }
function loveFace(): string[][] { // red heart eyes
  const g = grid();
  [6, 7, 8].forEach((r) => EYE_COLS.forEach((c) => (g[r][c] = "B")));
  LOVE.forEach((p) => (g[p[0]][p[1]] = "R"));
  return g;
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
    ctx.fillStyle = ch === "E" ? EYE : ch === "H" ? HILITE : ch === "Z" ? ZZZ : ch === "R" ? LOVE_RED : body;
    ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
  }
}

/** A few little hearts that float up + fade from `host` — fired when Goobi loves something. */
function emitHearts(host: HTMLElement): void {
  try { if (getComputedStyle(host).position === "static") host.style.position = "relative"; } catch { /* ignore */ }
  for (let i = 0; i < 3; i++) {
    const heart = document.createElement("span");
    heart.textContent = "♥";
    heart.style.cssText = `position:absolute;left:${28 + Math.random() * 44}%;top:6%;color:${LOVE_RED};font-size:${11 + Math.round(Math.random() * 6)}px;pointer-events:none;z-index:6;opacity:0;`;
    host.appendChild(heart);
    const rise = 26 + Math.random() * 22;
    heart.animate(
      [
        { transform: "translateY(0) scale(.5)", opacity: 0 },
        { transform: `translateY(-${rise * 0.4}px) scale(1)`, opacity: 1, offset: 0.3 },
        { transform: `translateY(-${rise}px) scale(.9)`, opacity: 0 },
      ],
      { duration: 1100 + Math.random() * 500, easing: "ease-out", delay: i * 130 },
    ).onfinish = () => heart.remove();
  }
}

const ANIM: Record<GoobiMood, string> = { idle: "g-bob", sleeping: "g-snooze", searching: "g-hunt", thinking: "g-think", happy: "g-bob", worn: "g-wobble", cheer: "g-tada", love: "g-love" };

/** Render a small, mood-driven Goobi into `host` (replaces its contents). Returns a
 *  handle to drive his mood. Frame loops self-stop when the canvas detaches (no leak). */
export function mountGoobi(host: HTMLElement, opts?: { cell?: number; playful?: boolean }): GoobiHandle {
  const cell = opts?.cell ?? 2;
  const playful = opts?.playful ?? false; // energetic idle (jumps/dances) for the playground
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
      const frames = [sleepFrame(ZLOW), sleepFrame(ZHIGH), sleepFrame(ZBIG), sleepFrame([])]; // a z that grows + rises, then a beat of none
      let i = 0;
      const tick = () => { if (!alive() || mood !== "sleeping") return; paint(ctx, frames[i % frames.length], cell, body); i++; timer = window.setTimeout(tick, 640); };
      tick();
    } else if (m === "searching") {
      // Eagerly scanning everywhere (right · center · up · left) over a hunting sway-hop.
      const frames = [eyesShift(1), grid(), eyesUp(), eyesShift(-1), grid()];
      const holds = [320, 190, 300, 320, 190];
      let i = 0;
      const tick = () => { if (!alive() || mood !== "searching") return; paint(ctx, frames[i % frames.length], cell, body); const hold = holds[i % holds.length]; i++; timer = window.setTimeout(tick, hold); };
      tick();
    } else if (m === "thinking") {
      // Eyes scan up-around while he concentrates (+ a gentle think-pulse css).
      const frames = [eyesUp(0), eyesUp(-1), eyesUp(0), eyesUp(1)];
      const holds = [560, 520, 560, 520];
      let i = 0;
      const tick = () => { if (!alive() || mood !== "thinking") return; paint(ctx, frames[i % frames.length], cell, body); const hold = holds[i % holds.length]; i++; timer = window.setTimeout(tick, hold); };
      tick();
    } else if (m === "love") {
      paint(ctx, loveFace(), cell, body); // red heart eyes + a smitten bounce (css)
      emitHearts(host); // little hearts float up

    } else if (m === "happy" || m === "cheer") {
      paint(ctx, faceWith(HAPPY), cell, body); // held ^‿^ + bob/tada (css)
    } else if (m === "worn") {
      paint(ctx, faceWith(XEYES), cell, body); // dizzy + red + wobble (css)
    } else { // idle — base bob + a varied, random rotation of little idle moves
      const p = (g: string[][]) => { if (alive() && mood === "idle") paint(ctx, g, cell, body); };
      paint(ctx, grid(), cell, body);
      // Eye flourishes (keep the bob; just repaint the eyes):
      const blink = () => { p(eyesHalf()); window.setTimeout(() => p(eyesClosed()), 70); window.setTimeout(() => p(eyesHalf()), 160); window.setTimeout(() => p(grid()), 230); };
      const look  = () => { p(eyesShift(1)); window.setTimeout(() => p(grid()), 620); window.setTimeout(() => p(eyesShift(-1)), 920); window.setTimeout(() => p(grid()), 1540); };
      const wink  = () => { p(winkRight()); window.setTimeout(() => p(grid()), 340); };
      // Body flourishes (swap the CSS animation for one cycle, then back to the bob):
      const base = () => { if (alive() && mood === "idle") { canvas.className = "gcv g-bob"; paint(ctx, grid(), cell, body); } };
      const css  = (cls: string, ms: number) => { if (alive() && mood === "idle") { canvas.className = "gcv " + cls; window.setTimeout(base, ms); } };
      const calm: Array<() => void> = [
        blink, blink, blink, look, wink,
        () => css("g-wiggle", 850), () => css("g-bounce", 1300), () => css("g-heartbeat", 1300), () => css("g-float", 3600),
      ];
      const lively: Array<() => void> = [ // playground: big, frequent, playful moves
        blink, look, wink,
        () => css("g-jump", 1100), () => css("g-bounce", 1300), () => css("g-wiggle", 850),
        () => css("g-dance", 1800), () => css("g-tada", 900), () => css("g-heartbeat", 1300),
      ];
      const FLOUR = playful ? lively : calm;
      const tick = () => {
        if (!alive() || mood !== "idle") return;
        FLOUR[Math.floor(Math.random() * FLOUR.length)]();
        timer = window.setTimeout(tick, playful ? 1100 + Math.random() * 1500 : 1700 + Math.random() * 2600);
      };
      timer = window.setTimeout(tick, playful ? 500 + Math.random() * 800 : 1000 + Math.random() * 1400);
    }
  }

  run("idle");
  return { el: canvas, setMood: (m) => { if (m !== mood) run(m); }, destroy: stop };
}
