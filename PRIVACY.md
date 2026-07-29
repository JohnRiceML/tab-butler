# Goobi privacy notice

Last updated: July 19, 2026

Goobi is a local-first browser extension for finding, drafting, and learning from conversations on X, with an included tab-management utility. This notice describes what the extension handles in its current private-beta build.

## What stays in the browser

Goobi stores settings and working data in Chrome local storage, including API keys, X handle and niche, voice examples, the user-authored SOUL.md, daily goals, products, reply activity, post drafts, target lists, manually entered DM notes and outcomes, local profile-check booleans, and growth experiments. The Growth loop is stored separately by X handle. The profile checker stores presence signals, not the text of the bio.

Goobi has no production server, account system, advertising SDK, or product-analytics service. The developer does not receive this locally stored data.

## Data sent to Anthropic

Claude features use the Anthropic API directly with the API key supplied by the user. Depending on the action, Goobi sends:

- public X post text and author handles for reply-opportunity scoring while the X copilot is enabled;
- selected public post/context, saved voice examples, the user-authored SOUL.md, optional product context, and user steering when the user requests a reply draft;
- public source posts, recent public posts from the user's account, niche, voice, SOUL.md, follower tier, and active growth-strategy brief when the user requests Post ideas or rewrites one;
- the selected public relationship context, saved voice, intent, and DM context the user has entered when the user requests a DM draft;
- tab titles, URLs, identifiers, and idle timing when the user explicitly enables and invokes Claude-powered tab grouping, cleanup, or archive search.

The extension does not send browser cookies, X passwords, native X direct-message inbox contents, or an automatically read DM history. SOUL.md is not sent with DM drafting. Anthropic processes API data under the terms and settings of the user's Anthropic API account. See the [Anthropic Privacy Center](https://privacy.anthropic.com/).

## Data sent to RapidAPI and the X-data provider

If the user supplies a RapidAPI key and invokes an X-data feature, Goobi sends public X handles, search queries, and endpoint parameters to the configured `twitter241` RapidAPI provider. Returned public profile and post data is used for follower counts, recommendation context, Targets, public DM research, own-post measurements, and outcome learning. The feature is optional and governed by the user's RapidAPI subscription and the provider's terms.

## How the data is used

Goobi uses data only to provide the visible extension features the user enables: tab organization, X recommendations, drafting, account-safety feedback, relationship workspaces, and local outcome learning. It does not sell data, use it for advertising, build unrelated profiles, or allow the developer to read private user content.

Goobi's use of information obtained through Chrome APIs is limited to providing and improving its disclosed user-facing features and follows the Chrome Web Store User Data Policy's Limited Use requirements.

## Retention and deletion

Local data remains until the user clears it, removes individual saved items where controls are available, clears the extension's site data in Chrome, or uninstalls the extension. Growth daily snapshots are automatically bounded to 90 days and completed strategy history to 12 experiments. API providers may retain transmitted data under their own policies and the user's account arrangements.

Removing the Anthropic or RapidAPI key stops future calls to that provider. Turning off the X copilot stops X-page processing after X is reloaded.

## Security

External requests use HTTPS. API keys are stored in Chrome local extension storage and are sent only to the provider they authenticate. Keys are not bundled in the extension or placed in the X page.

## Contact and publication note

Private-beta users should contact the person or organization that supplied their build. Before a public store listing, the publisher must replace this paragraph with a stable support/privacy contact and host this notice at the URL entered in the Chrome Web Store Developer Dashboard.
