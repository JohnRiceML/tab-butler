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
Fresh installs open Guided X setup. Choose the recommended Jev + Claude setup,
add user-owned TypeSafe and Anthropic keys, accept the separate disclosures, and
save a focus. Review the first-reply walkthrough, then enable Goobi and open X.
The side panel resumes unfinished setup; Conversations can reopen the guide.
Jev analysis also applies to LinkedIn if separately enabled; Claude-only analysis
remains supported. Optional Jev comment review has a separate consent control.

No secrets are required to compile or run the zero-cost tests. Never commit
`extension/goobi.local.json`; it is an optional local settings seed and is ignored.

## Commands

From the repository root:

```bash
npm run setup       # locked dependency install in extension/
npm run verify      # typecheck + all unit suites + build + dist validation
npm test            # all zero-cost extension test suites
npm run build       # rebuild extension/dist/ (distributable — strips the dev beacon)
npm run dev         # watch mode: rebuild on save + hot-reload + refresh open X/LinkedIn tabs
```

Dev loop: load `extension/dist/` unpacked ONCE, then `npm run dev` — every save rebuilds and the
extension reloads itself (the service worker polls `dist/dev-reload.json`, which only exists in
watch builds) and refreshes open X/LinkedIn tabs so fresh content scripts take over. When done,
Ctrl-C and run `npm run build`: it deletes the beacon, and `check:dist` fails any dist/ that
still carries one.

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
- `extension/src/content/linkedin-copilot.ts`: focused LinkedIn feed/comment integration.
- `extension/src/background/service-worker.ts`: extension orchestration and provider calls.
- `extension/src/popup/popup.ts`: side-panel settings and activity UI.
- `extension/src/lib/`: pure policy, parsing, scoring, learning, and workspace modules.

## Manual browser smoke test

Run this after DOM, manifest, permission, or reply-action changes. Record the browser,
extension commit, and result in the handoff/release notes.

1. Use a clean Chrome profile and load `extension/dist/`.
   Confirm the welcome tab appears once on install, never on update or startup.
   Close and reopen after each saved setup step to verify resumption. Verify
   provider settings do not enable scanning before the final action; test both
   Jev + Claude and Claude-only paths. Existing configured profiles bypass setup.
2. Confirm the first-run gates block both platforms before their separate consent/key setup.
3. Accept each disclosure under test, save an Anthropic key and focus, then refresh X/LinkedIn.
4. Confirm feed scanning produces explainable reply spots. Verify Replies and Comments
   are the main dock views, Scan this page works without RapidAPI, and More tools
   still reaches search, post ideas, DMs, growth, and target accounts. Verify each
   secondary view can return to Replies. Expand today's pace details for goals.
5. Confirm a visible `Replying to @you` post is labeled **Comment on your post**.
6. Draft a reply and verify the voice/steer controls regenerate the same context.
7. For a visible feed post, verify the reply action copies the draft, smoothly scrolls
   that exact post into view, and temporarily outlines it; it must not click Reply, like,
   touch the composer, or count it.
8. For an off-page result, verify **Copy & open exact post** opens the matching status
   page without opening or filling its composer.
9. Paste and post manually, then verify **Mark as posted** updates both activity UIs.
10. Open X notifications and confirm direct comments and mentions are labeled separately.
11. Exercise pause/resume, the Goobi playground, and one tab-manager group/archive/undo cycle.
12. Enable Jev analysis with its explicit consent and TypeSafe key; confirm analysis
    uses Jev and requested drafts use Claude. Leave comment review off. A missing
    TypeSafe key must not show a Ready status when Jev is selected. Confirm existing
    Claude-only setups still work and no provider selection changes on update.
13. Remove stored keys and confirm future provider calls stop.

LinkedIn pass: browse the main feed, confirm only non-promoted feed posts are
considered and the post author's portrait (or initial fallback) appears, draft and steer one
comment, choose **Copy & review**, and verify the exact card scrolls into view and immediately
shows **Commented**, increases local activity, and disappears from the queue. Exercise **Undo last
mark** and verify the opportunity returns; legacy in-review receipts still support **Not posted** and
**Mark posted**. Test pause/resume with a draft open and SPA
navigation through a rejected route such as Jobs. Confirm its count is stored separately
from the X reply ledger and that no dock or provider call appears on the rejected route.

Chrome keeps old content scripts alive in already-open X tabs after an extension reload.
Refresh or reopen every X and LinkedIn tab before diagnosing behavior from a new build.

## Data and secrets

- Anthropic and RapidAPI keys live in `chrome.storage.local` and call providers directly.
- Public X post text is sent to Claude for enabled ambient scoring; richer drafting context
  is sent only after a user asks for a draft.
- LinkedIn feed post text visible to the user, displayed author names, bounded visible headline/kind/connection-label context, saved focus, and the user-written LinkedIn comment thesis are sent to Claude only when that separate copilot is enabled; drafting also sends the selected post, fit guidance, voice/SOUL, and any explicit Real detail.
- Native X DMs, LinkedIn messages, browser cookies, and platform passwords are never read.
- `extension/dist/`, `node_modules/`, `.env*`, logs, and `goobi.local.json` are ignored.

See `PRIVACY.md` for the complete disclosure and retention description.

## Known boundaries

- Goobi never clicks X's final Reply/Post button or LinkedIn's Comment control and never sends DMs automatically.
- X and LinkedIn DOM extraction is best effort and requires manual smoke testing when either site changes markup.
- RapidAPI enrichment and measured outcome loops are optional and provider-plan dependent.
- The `proxy/` directory is parked; do not point the shipping manifest at it without a
  separate authentication, origin-allowlist, privacy, and deployment review.
- The package currently combines two social copilots and a tab manager. Resolve the single-purpose
  and permission scope before a Chrome Web Store submission.
- No open-source license has been selected. The owner must choose one before inviting
  unrestricted public reuse; private collaborators can still clone and run the repository.

## Definition of handoff-ready

- The intended changes are committed and pushed to a named branch or tag.
- `npm run verify` passes from a clean clone.
- The manual browser smoke test above is recorded.
- `PRIVACY.md` contains a real support contact before external/public distribution.
- Provider terms and the final Chrome permission scope have been reviewed for the intended audience.
