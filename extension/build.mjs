import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: {
    "service-worker": "src/background/service-worker.ts",
    popup: "src/popup/popup.ts",
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "dist",
  logLevel: "info",
});

// Content script: classic IIFE (content_scripts are not ES modules).
await build({
  entryPoints: { "x-copilot": "src/content/x-copilot.ts" },
  bundle: true,
  format: "iife",
  target: "es2022",
  outdir: "dist",
  logLevel: "info",
});

cpSync("manifest.json", "dist/manifest.json");
cpSync("src/popup/popup.html", "dist/popup.html");
// Optional, GITIGNORED local settings seed (keys/voice/products) — the SW restores empty settings
// from it on a fresh install, so a remove+re-add doesn't mean re-typing everything.
// Copy goobi.local.example.json → goobi.local.json and fill it in. Never commit it.
if (existsSync("goobi.local.json")) cpSync("goobi.local.json", "dist/goobi.local.json");

console.log("Built → dist/ (load this folder as an unpacked extension)");
