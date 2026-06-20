# Tab Butler

Local-first browser tab hygiene with an opt-in Claude smart layer.

- **Auto-bundles** related tabs into named, color-coded groups
- **Safely archives** idle tabs (archive-not-delete + one-click undo)
- **Made smart by Claude** (opt-in): semantic group names + ranked cleanup
- **`tab-butler` CLI**: list / kill / Claude-clean localhost dev servers from
  the terminal — where dev-server hygiene belongs

Two simple pieces: a browser **extension** for tabs, and a terminal **CLI** for
dev servers. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Layout

```
extension/    MV3 Chrome/Edge extension (TypeScript, esbuild) — browser tabs
cli/          Zero-dep Node CLI — list/kill/Claude-clean localhost dev servers
proxy/        Next.js proxy (parked) — optional hosted Claude tier; not required
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

## Dev servers — the CLI

Killing a process is impossible from a browser extension, and the terminal is
the natural home for dev-server hygiene anyway. The `cli/` tool handles it:

```bash
node cli/tab-butler.mjs ls          # list listening dev servers (port, RAM, uptime)
node cli/tab-butler.mjs kill 6006   # SIGTERM whatever listens on :6006
ANTHROPIC_API_KEY=sk-ant-... \
  node cli/tab-butler.mjs clean     # Claude picks stale ones, asks before killing

cd cli && npm link                  # optional: global `tb ls` / `tb clean`
```

Zero dependencies. Only touches processes *listening* on a port, and only dev
runtimes (node/python/vite/…). See [cli/README.md](cli/README.md).

## Privacy

The smart layer is **opt-in** (`smartEnabled` in `chrome.storage.local`) and
only ever sends tab **id / title / url / idle-time** — never page content.
Before publishing, wire real auth in `proxy/src/lib/http.ts` and post a privacy
policy (Chrome Web Store limited-use requirement). The local-first base sends
nothing off-device.

## Status

v1 scaffold. The extension (tabs) + CLI (dev servers) both work. Not yet wired:
real auth on the optional proxy, BYO-key Claude direct from the extension (so no
server is needed), a settings/opt-in UI, auto-bookmarking, and semantic ⌘K
recall. The Swift menubar app was removed in favor of the CLI (it's in git
history if the always-on RAM widget is ever wanted). See the architecture doc.
