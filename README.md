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
extension/   MV3 Chrome/Edge extension (TypeScript, esbuild)
proxy/       Next.js managed-tier proxy — holds the Anthropic key, exposes
             /api/classify (Haiku) and /api/advise (Opus 4.8)
docs/        Architecture spec
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
npm run dev                       # http://localhost:3000
```

The extension calls `http://localhost:3000` by default
(`extension/src/lib/config.ts` → `PROXY_BASE_URL`). Set it to your Vercel URL
for production, and add that origin to `manifest.json` `host_permissions`.

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
