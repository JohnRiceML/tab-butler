# tab-butler CLI

List, kill, and Claude-clean localhost dev servers — from the terminal. Zero
dependencies (Node 18+). The right home for dev-server hygiene: no browser, no
native messaging, no menubar app.

```bash
node tab-butler.mjs ls            # list listening dev servers (port, RAM, uptime)
node tab-butler.mjs kill 6006     # SIGTERM whatever listens on :6006
node tab-butler.mjs clean         # Claude picks stale ones, asks before killing
node tab-butler.mjs clean --yes   # ...and kills without prompting

# optional: install a global `tb` command
npm link            # then: tb ls / tb kill 3000 / tb clean
```

`clean` needs `ANTHROPIC_API_KEY` in the environment:

```bash
ANTHROPIC_API_KEY=sk-ant-... node tab-butler.mjs clean
```

It only ever touches processes **listening** on a port, and only ones whose
command looks like a dev runtime (node, python, vite, …) — never system services.
