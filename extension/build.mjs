import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });

const esmOpts = {
  entryPoints: {
    "service-worker": "src/background/service-worker.ts",
    popup: "src/popup/popup.ts",
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "dist",
  logLevel: "info",
};

// Content script: classic IIFE (content_scripts are not ES modules).
const iifeOpts = {
  entryPoints: { "x-copilot": "src/content/x-copilot.ts" },
  bundle: true,
  format: "iife",
  target: "es2022",
  outdir: "dist",
  logLevel: "info",
};

function copyStatic() {
  cpSync("manifest.json", "dist/manifest.json");
  cpSync("src/popup/popup.html", "dist/popup.html");
  // Optional, GITIGNORED local settings seed (keys/voice/products) — the SW restores empty settings
  // from it on a fresh install, so a remove+re-add doesn't mean re-typing everything.
  // Copy goobi.local.example.json → goobi.local.json and fill it in. Never commit it.
  if (existsSync("goobi.local.json")) cpSync("goobi.local.json", "dist/goobi.local.json");
}

if (!watch) {
  await build(esmOpts);
  await build(iifeOpts);
  copyStatic();
  // A distributable build must NEVER carry the dev hot-reload beacon (check-dist enforces this):
  // its presence is what arms the service worker's dev reload poller.
  rmSync("dist/dev-reload.json", { force: true });
  console.log("Built → dist/ (load this folder as an unpacked extension)");
} else {
  // Dev watch mode: rebuild on save, then bump dist/dev-reload.json. The service worker polls
  // that beacon (only when it exists), chrome.runtime.reload()s itself on a bump, and refreshes
  // open X tabs on the way back up — no manual extension-reload or tab-refresh during dev.
  let devId = 0;
  let beaconTimer;
  const bumpBeacon = () => {
    clearTimeout(beaconTimer);
    beaconTimer = setTimeout(() => {
      copyStatic();
      writeFileSync("dist/dev-reload.json", JSON.stringify({ id: ++devId }));
      console.log(`[dev] rebuilt → reload beacon #${devId}`);
    }, 250); // debounce: one shared source change rebuilds both contexts — bump once, reload once
  };
  const onEnd = { name: "dev-reload-beacon", setup(b) { b.onEnd((r) => { if (r.errors.length === 0) bumpBeacon(); else console.log("[dev] build errors — beacon NOT bumped"); }); } };
  const ctxA = await context({ ...esmOpts, plugins: [onEnd] });
  const ctxB = await context({ ...iifeOpts, plugins: [onEnd] });
  await ctxA.watch();
  await ctxB.watch();
  console.log("[dev] watching src/ — load dist/ unpacked once; rebuilds hot-reload the extension and refresh open X tabs. Ctrl-C to stop, then run `npm run build` to strip the dev beacon.");
}
