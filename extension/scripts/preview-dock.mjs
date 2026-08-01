import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "../src/content/x-copilot.ts");
const port = Number(process.env.GOOBI_PREVIEW_PORT || 4177);

function page(css, legacy) {
  const headerDiscovery = legacy
    ? `<button class="findb">✦ Find spots</button>
        <button class="findb">⚡ Fresh reach</button>`
    : "";
  const discoveryRow = legacy
    ? ""
    : `<div class="discovery" aria-label="Find reply opportunities">
      <button class="findb secondary">✦ Find spots</button>
      <button class="findb">⚡ Fresh reach</button>
    </div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Goobi dock header preview</title>
  <style>
    ${css}
    html, body { margin:0; min-height:100%; background:#000; color:#fff; }
    body {
      min-height:720px;
      display:flex;
      align-items:flex-start;
      justify-content:flex-end;
      padding:38px 32px;
      box-sizing:border-box;
      background:radial-gradient(circle at 78% 18%,#17202b 0,#090b0f 52%,#000 100%);
    }
    .d { position:relative !important; }
    .d::after {
      content:"452px dock";
      position:absolute;
      top:-24px;
      right:0;
      color:#b6a892;
      font:600 11px -apple-system,system-ui,sans-serif;
    }
    .blob {
      position:relative;
      display:block;
      width:34px;
      height:30px;
      border-radius:52% 48% 45% 55%;
      background:linear-gradient(145deg,#f4b07e,#f4411f);
      box-shadow:0 3px 9px rgba(244,65,31,.25);
    }
    .blob i {
      position:absolute;
      top:10px;
      width:4px;
      height:5px;
      border-radius:50%;
      background:#1a1206;
    }
    .blob i:first-child { left:9px; }
    .blob i:last-child { right:9px; }
  </style>
</head>
<body>
  <main class="d" aria-label="Goobi dock preview">
    <header class="dh">
      <div class="dhl">
        <div class="dhgoobi" aria-label="Goobi">
          <span class="blob"><i></i><i></i></span>
        </div>
        <div class="dt">
          <div class="dtitle">8 reply spots</div>
          <div class="dsub"><span class="pace" style="color:#6fcf7f">Good pace</span> · 4 verified</div>
        </div>
      </div>
      <div class="da">
        ${headerDiscovery}
        <button class="iconb" aria-label="More actions">⋮</button>
        <button class="iconb" aria-label="Minimize the dock">–</button>
      </div>
    </header>
    ${discoveryRow}
    <nav class="modes" aria-label="Goobi workspace">
      <button class="mode on">Replies <span class="mode-count">8</span></button>
      <button class="mode">Comments</button>
      <button class="mode">Post ideas</button>
      <button class="mode">DMs</button>
      <button class="mode">Growth</button>
    </nav>
    <section class="day-goals">
      <div class="dg-head">
        <span class="dg-title">Today</span>
        <span class="dg-summary">4 / 10 replies · 1 post</span>
      </div>
      <div style="height:54px;border-radius:10px;background:#1d1812;border:1px solid rgba(214,154,92,.12)"></div>
    </section>
    <section class="dl" style="padding:10px 14px 14px">
      <article class="it reply-card fresh-hero">
        <div class="fresh-hero-head">
          <div>
            <div class="fresh-hero-title">⚡ Best observed reach opening now</div>
            <div class="fresh-hero-sub">8m old · 3 replies · 7.2× your audience · 84 content fit</div>
          </div>
          <span class="fresh-hero-band">exceptional opening</span>
        </div>
        <div class="reply-summary">
          <div class="reply-toggle" style="display:flex;gap:10px;align-items:center">
            <span class="av init" style="background:#5a6540">A</span>
            <div class="reply-copy">
              <div class="reply-id"><div class="nm"><span class="nmt">@alicebuilds</span><span class="fc">7.2K followers</span></div></div>
              <div class="reply-compact-meta"><span class="reply-lane" style="color:#d69a5c">Earn reach</span><span class="reply-strength" style="color:#d69a5c;background:#d69a5c1f">Best next</span><span class="reply-age">· 8m · ⚡ fresh reach</span></div>
              <div class="reply-compact-text">The biggest onboarding mistake is asking for commitment before the user reaches value.</div>
            </div>
          </div>
          <div class="reply-summary-actions"><button class="reply-draft-quick">Draft</button><button class="reply-disclose">▾</button></div>
        </div>
      </article>
    </section>
  </main>
</body>
</html>`;
}

createServer(async (request, response) => {
  try {
    const source = await readFile(sourcePath, "utf8");
    const match = source.match(/const DOCK_CSS = \`([\s\S]*?)\`;\n/);
    if (!match) throw new Error("Could not find DOCK_CSS");
    const css = match[1]
      .replaceAll("${ACCENT}", "#d69a5c")
      .replaceAll("${INK}", "#1a1206");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    const legacy = new URL(request.url || "/", `http://${request.headers.host}`).searchParams.has("legacy");
    response.end(page(css, legacy));
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(error));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Goobi dock preview: http://127.0.0.1:${port}`);
});
