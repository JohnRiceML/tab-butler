# External release checklist

## Ready for a controlled private beta

- A fresh clone can run `npm run setup` followed by `npm run verify`; the gate covers
  TypeScript, every zero-cost regression suite, the production build, and MV3 artifact validation.
- Shipping extension uses only direct, user-keyed Anthropic and RapidAPI hosts; dead localhost and placeholder-proxy permissions are removed.
- X content processing is off until the user accepts the in-product data disclosure. The disclosure names automatic public-post scoring, on-demand drafting context, RapidAPI queries, and local storage.
- Growth experiments are account-scoped, block handle/session mismatches, require measured execution before a verdict, preserve zero outcomes, and expose evidence without hover.
- Claude output remains draft-only. Goobi never submits replies, posts, follows, or DMs.
- Pure test suites, TypeScript, and production build are required before every shared build.

## Required before a Chrome Web Store listing

- **Choose one store purpose.** The current package combines an X growth copilot and a general tab manager. Chrome's single-purpose and minimum-permission policies make this the largest review risk. The clean release path is separate extension packages/manifests, or a deliberately scoped product definition reviewed against current policy.
- **Host the privacy notice.** Replace the contact placeholder in `PRIVACY.md`, publish it on a stable HTTPS page, and add that URL in the Developer Dashboard.
- **Complete listing disclosures.** The listing and Privacy practices tab must match the in-product disclosure: website/public-post content, user-generated voice/DM context, browsing history and URLs for tab features, authentication/API keys, local activity records, and the Anthropic/RapidAPI transfers.
- **Permission audit after packaging choice.** An X-only build should not request `tabs`, `tabGroups`, `history`, `bookmarks`, `system.memory`, `sessions`, `idle`, or tab-manager alarms. A tab-only build should not request X/Twitter content-script access or RapidAPI hosts.
- **Stable support identity.** Add a publisher name, support email/site, versioned privacy contact, and support instructions.
- **Clean-profile smoke test.** Install into a fresh Chrome profile and verify disclosure → key → niche → X reload → scan → draft → Growth test, plus removal of keys and uninstall data behavior.
- **Provider review.** Confirm that the chosen X-data provider plan and intended distribution permit the product's use, and make provider naming/cost expectations clear to beta users.

This checklist is an engineering readiness aid, not legal advice.
