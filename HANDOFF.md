# Goobi maintainer handoff

This is the shortest path for another developer to clone, verify, load, and safely
change Goobi. The shipping product is the MV3 extension under `extension/`; the
managed proxy is parked and is not part of the live path.

## First hour

Prerequisites: Git, Chrome or Edge, and Node.js 20 or newer.

```bash
git clone https://github.com/JohnRiceML/tab-butler.git
cd tab-butler
npm run setup
npm run verify
```

Then load `extension/dist/` as an unpacked extension from `chrome://extensions`.
Open Goobi's side panel, accept the X data disclosure, add a user-owned Anthropic
key, set a niche, and refresh `x.com`.

No secrets are required to compile or run the zero-cost tests. Never commit
`extension/goobi.local.json`; it is an optional local settings seed and is ignored.

## Commands

From the repository root:

```bash
npm run setup       # locked dependency install in extension/
npm run verify      # typecheck + all unit suites + build + dist validation
npm test            # all zero-cost extension test suites
npm run build       # rebuild extension/dist/
```

From `extension/`, the equivalent commands are available directly. The deterministic
test runner includes every `scripts/test-*.mjs` file and intentionally excludes
credentialed scripts named `eval-*`, `live-*`, `spike-*`, and `backtest-*`.
GitHub Actions runs the same locked setup and verification gate on every push and
pull request (`.github/workflows/verify.yml`).

## Where to start reading

- `README.md`: product value, installation, privacy summary.
- `docs/ARCHITECTURE.md`: runtime boundaries and privacy model.
- `docs/SYSTEM.md`: module and storage-key map.
- `docs/flows/README.md`: index of end-to-end feature flows.
- `docs/flows/reply-spots.md`: the primary scan → score → draft → insert loop.
- `docs/flows/account-safety.md`: pace, duplicate, and same-author protections.
- `docs/RELEASE-CHECKLIST.md`: private-beta and public-store gates.
- `PRIVACY.md`: current private-beta data notice.

Primary implementation entry points:

- `extension/src/content/x-copilot.ts`: X DOM integration and Goobi dock.
- `extension/src/background/service-worker.ts`: extension orchestration and provider calls.
- `extension/src/popup/popup.ts`: side-panel settings and activity UI.
- `extension/src/lib/`: pure policy, parsing, scoring, learning, and workspace modules.

## Manual browser smoke test

Run this after DOM, manifest, permission, or reply-action changes. Record the browser,
extension commit, and result in the handoff/release notes.

1. Use a clean Chrome profile and load `extension/dist/`.
2. Confirm the first-run gate blocks X processing before consent/key setup.
3. Accept disclosure, save an Anthropic key and niche, then refresh X.
4. Confirm feed scanning produces explainable reply spots.
5. Confirm a visible `Replying to @you` post is labeled **Comment on your post**.
6. Draft a reply and verify the voice/steer controls regenerate the same context.
7. With **Like + insert reply** enabled, verify the selected post is liked, its empty
   composer is filled, Goobi closes, and both activity UIs update. Goobi must not submit.
8. Disable the setting and verify copy + open retains the manual confirmation screen.
9. Verify an occupied composer is never overwritten.
10. Open X notifications and confirm direct comments and mentions are labeled separately.
11. Exercise pause/resume, the Goobi playground, and one tab-manager group/archive/undo cycle.
12. Remove stored keys and confirm future provider calls stop.

Chrome keeps old content scripts alive in already-open X tabs after an extension reload.
Refresh or reopen every X tab before diagnosing behavior from a new build.

## Data and secrets

- Anthropic and RapidAPI keys live in `chrome.storage.local` and call providers directly.
- Public X post text is sent to Claude for enabled ambient scoring; richer drafting context
  is sent only after a user asks for a draft.
- Native X DMs, browser cookies, and X passwords are never read.
- `extension/dist/`, `node_modules/`, `.env*`, logs, and `goobi.local.json` are ignored.

See `PRIVACY.md` for the complete disclosure and retention description.

## Known boundaries

- Goobi never clicks X's final Reply/Post button and never sends DMs automatically.
- X DOM extraction is best effort and requires manual smoke testing when X changes markup.
- RapidAPI enrichment and measured outcome loops are optional and provider-plan dependent.
- The `proxy/` directory is parked; do not point the shipping manifest at it without a
  separate authentication, origin-allowlist, privacy, and deployment review.
- The package currently combines an X copilot and tab manager. Resolve the single-purpose
  and permission scope before a Chrome Web Store submission.
- No open-source license has been selected. The owner must choose one before inviting
  unrestricted public reuse; private collaborators can still clone and run the repository.

## Definition of handoff-ready

- The intended changes are committed and pushed to a named branch or tag.
- `npm run verify` passes from a clean clone.
- The manual browser smoke test above is recorded.
- `PRIVACY.md` contains a real support contact before external/public distribution.
- Provider terms and the final Chrome permission scope have been reviewed for the intended audience.
