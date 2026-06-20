# Tab Butler

Local-first browser tab hygiene with an opt-in Claude smart layer.

- **Auto-bundles** related tabs into named, color-coded groups
- **Safely archives** idle tabs (archive-not-delete + one-click undo)
- **Made smart by Claude** (opt-in): semantic group names, ranked cleanup
  recommendations, localhost awareness
- **Honest about RAM**: per-tab memory is impossible on stable Chrome, so the
  (v1.5) native menubar companion reports per-*process* RAM, like Chrome's own
  Task Manager

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and the
v1 vs v1.5 split.

## Layout

```
extension/    MV3 Chrome/Edge extension (TypeScript, esbuild)
proxy/        Next.js managed-tier proxy — holds the Anthropic key, exposes
              /api/classify (Haiku) and /api/advise (Opus 4.8)
native-host/  Native messaging helper to list & kill localhost dev servers
docs/         Architecture spec
```

## Quick start

### Extension

```bash
cd extension
npm install
npm run build        # → dist/
```

Then load `extension/dist/` as an unpacked extension at
`chrome://extensions` (Developer mode → Load unpacked). The local-first
features (group-by-site, idle-archive, undo) work with no backend.

### Proxy (the Claude "smart" tier)

```bash
cd proxy
npm install
npm i @anthropic-ai/sdk@latest    # ensure messages.parse + zod helpers
cp .env.example .env.local        # add ANTHROPIC_API_KEY
npm run dev                       # http://localhost:3210
```

The proxy runs on a dedicated port (**3210**) to avoid the common `:3000`
collision with other dev servers. The extension calls `http://localhost:3210`
by default (`extension/src/lib/config.ts` → `PROXY_BASE_URL`). Set it to your
Vercel URL for production, and add that origin to `manifest.json`
`host_permissions`.

If a key is exported in your shell it shadows `.env.local` (Next won't override
`process.env`). Run scrubbed if so: `env -u ANTHROPIC_API_KEY npm run dev`.

## Kill localhost dev servers (native helper)

The extension can't kill a process — Chrome's sandbox forbids it. The optional
helper in `native-host/` does it via native messaging (`lsof` + `kill`). Once
installed, the popup shows a **Servers running** list (filtered to dev runtimes —
node, python, vite, etc., never system services) with a **Kill** button.

```bash
# 1. Load the extension first (chrome://extensions → Load unpacked → extension/dist)
# 2. Copy its ID from the extension card, then:
cd native-host
./install.sh <extension-id>
# 3. Fully quit & reopen the browser, then reload the extension.
```

Without the helper, the popup falls back to listing localhost *tabs* with a
"Close tab" action (which closes the tab but leaves the server running).

Test the helper standalone (lists your listening dev ports):

```bash
node -e 'const cp=require("child_process");const f=o=>{const m=Buffer.from(JSON.stringify(o)),l=Buffer.alloc(4);l.writeUInt32LE(m.length);return Buffer.concat([l,m])};const p=cp.spawn("node",["native-host/tabbutler-host.mjs"]);const o=[];p.stdout.on("data",d=>o.push(d));p.on("close",()=>{const b=Buffer.concat(o);console.log(b.slice(4,4+b.readUInt32LE(0)).toString())});p.stdin.end(f({action:"list"}))'
```

Kill sends `SIGTERM` to whatever is *listening* on the given port (dev servers
only). It never touches non-listening processes.

## Privacy

The smart layer is **opt-in** (`smartEnabled` in `chrome.storage.local`) and
only ever sends tab **id / title / url / idle-time** — never page content.
Before publishing, wire real auth in `proxy/src/lib/http.ts` and post a privacy
policy (Chrome Web Store limited-use requirement). The local-first base sends
nothing off-device.

## Status

v1 scaffold. Not yet wired: real auth, the settings/opt-in UI, auto-bookmarking,
the ⌘K palette, and the v1.5 SwiftUI menubar companion (per-process RAM +
localhost + bring-your-own-key). See the architecture doc.
