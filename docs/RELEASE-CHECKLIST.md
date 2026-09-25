# External release checklist

## Controlled private-use build (not public-distribution clearance)

- A fresh clone can run `npm run setup` followed by `npm run verify`; the gate covers
  TypeScript, every zero-cost regression suite, the production build, and MV3 artifact validation.
- Shipping extension uses only direct, user-keyed Anthropic, TypeSafe (Jev), and RapidAPI hosts; dead localhost and placeholder-proxy permissions are removed.
- X content processing is off until the user accepts the in-product data disclosure. The disclosure names automatic public-post scoring, on-demand drafting context, RapidAPI queries, and local storage.
- LinkedIn processing has its own opt-in disclosure and separate comment ledger. Its focused v1 has no API enrichment, private-message access, reactions, connection/follow actions, or composer automation.
- Growth experiments are account-scoped, block handle/session mismatches, require measured execution before a verdict, preserve zero outcomes, and expose evidence without hover.
- Claude output remains draft-only. Reply handoffs are copy-only: Goobi never clicks Reply, fills the composer, likes, submits replies, posts, or sends DMs.
- The explicit user-clicked **+ Follow** action still scripts X's menu and clicks Follow. Keep that DOM helper to controlled private use. User initiation and pacing reduce surprise but do not make non-API browser scripting ready for public distribution.
- Pure test suites, TypeScript, and production build are required before every shared build.

## Required before a Chrome Web Store listing

- **Resolve X platform-policy risk.** Composer activation/prefill and scripted Like have been removed. A public build must still remove/replace non-API browser scripting and scraping—including ambient DOM harvesting and scripted Follow—and use an approved official interface unless X grants written authorization. Unofficial X-data access likewise needs documented X authorization; a third-party provider subscription alone is not proof of it.
- **Resolve LinkedIn platform-policy risk.** The private prototype reads visible feed DOM and adds an overlay. Draft-only behavior reduces automation risk, but does not itself provide public-distribution authorization. Obtain authorization or replace the DOM integration with an approved interface before a public listing.
- **Choose one store purpose.** The current package combines an X growth copilot and a general tab manager. Chrome's single-purpose and minimum-permission policies make this the largest review risk. The clean release path is separate extension packages/manifests, or a deliberately scoped product definition reviewed against current policy.
- **Host the privacy notice.** Replace the contact placeholder in `PRIVACY.md`, publish it on a stable HTTPS page, and add that URL in the Developer Dashboard.
- **Complete listing disclosures.** The listing and Privacy practices tab must match the in-product disclosure: website/public-post content, user-generated voice/DM context, browsing history and URLs for tab features, authentication/API keys, local activity records, and the Anthropic/TypeSafe/RapidAPI transfers.
- **Permission audit after packaging choice.** An X-only build should not request `tabs`, `tabGroups`, `history`, `bookmarks`, `system.memory`, `sessions`, `idle`, or tab-manager alarms. A tab-only build should not request X/Twitter content-script access or RapidAPI hosts.
- **Stable support identity.** Add a publisher name, support email/site, versioned privacy contact, and support instructions.
- **Clean-profile smoke test.** Install into a fresh Chrome profile and verify each disclosure separately, then key → focus → LinkedIn comment thesis → platform reload → scan → draft → copy-only/manual-post flow. On LinkedIn, verify person/post/contribution explanations, limited-author-context fallback, repeat-author spacing, author portrait/initial fallbacks, Copy & review → immediate Commented label + queue removal, exact undo, and legacy in-review dismissal. Confirm LinkedIn and X activity never cross ledgers, plus removal of keys and uninstall data behavior.
- **Provider review.** Confirm both that the chosen X-data provider plan permits the intended distribution and that its access is authorized by X; make provider naming/cost expectations clear to beta users.

This checklist is an engineering readiness aid, not legal advice.
