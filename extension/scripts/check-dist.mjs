/** Fail the handoff gate if the generated unpacked extension is incomplete or unsafe. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const required = ["manifest.json", "service-worker.js", "popup.html", "popup.js", "x-copilot.js", "linkedin-copilot.js"];

for (const name of required) {
  const path = join(dist, name);
  if (!existsSync(path) || statSync(path).size === 0) {
    console.error(`Missing or empty build artifact: dist/${name}`);
    process.exit(1);
  }
}

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const failures = [];
if (manifest.manifest_version !== 3) failures.push("manifest_version must be 3");
if (manifest.name !== "Goobi") failures.push("manifest name must be Goobi");
if (manifest.background?.service_worker !== "service-worker.js") failures.push("service worker path is invalid");
if (manifest.side_panel?.default_path !== "popup.html") failures.push("side panel path is invalid");
if (!manifest.content_scripts?.some((entry) => entry.js?.includes("x-copilot.js"))) failures.push("X content script is missing");
const liEntry = manifest.content_scripts?.find((entry) => entry.js?.includes("linkedin-copilot.js"));
if (!liEntry) failures.push("LinkedIn content script is missing");
else {
  if (JSON.stringify(liEntry.matches) !== JSON.stringify(["https://www.linkedin.com/*"])) failures.push("LinkedIn content script must stay scoped to www.linkedin.com");
  if (liEntry.all_frames !== false) failures.push("LinkedIn content script must stay in the top frame");
}

const manifestText = JSON.stringify(manifest);
if (/YOUR-PROXY|localhost|127\.0\.0\.1/i.test(manifestText)) failures.push("development or placeholder hosts remain in the shipping manifest");

// The dev hot-reload beacon must never ship: its presence is what arms the service worker's
// reload poller. `node build.mjs` (no --watch) deletes it; a leftover means dist/ was last
// produced by watch mode — rebuild before distributing.
if (existsSync(join(dist, "dev-reload.json"))) failures.push("dev-reload.json (watch-mode hot-reload beacon) is present — run `npm run build` to produce a distributable dist/");
if (existsSync(join(dist, "goobi.local.json"))) failures.push("goobi.local.json contains machine-local settings/secrets and must never be present in a distributable build");

if (failures.length) {
  for (const failure of failures) console.error(`Build check failed: ${failure}`);
  process.exit(1);
}

console.log("✓ dist/ is a complete MV3 unpacked Goobi build");
