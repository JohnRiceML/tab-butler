# Goobi privacy notice

Last updated: September 21, 2026

Goobi is a local-first browser extension for finding and drafting contributions to public conversations on X and LinkedIn, with an included tab-management utility. This notice describes what the extension handles in its current private-beta build.

## What stays in the browser

Goobi stores settings and working data in Chrome local storage, including API keys, X handle and focus, shared voice examples, optional LinkedIn-specific voice notes/examples, an explicit LinkedIn comment thesis, the user-authored SOUL.md, daily goals, products, X reply activity, LinkedIn in-review and Commented activity, post drafts, target lists, manually entered DM notes and outcomes, local profile-check booleans, and growth experiments. The LinkedIn thesis contains only user-entered professional arena, reputation goal, target audiences/post situations/contribution lanes, exclusions, and relationship-spacing preferences. LinkedIn activity receipts contain post identity, displayed author, optional visible profile-path key, optional permalink, and timestamps, but not draft text or per-draft Real detail. X and LinkedIn activity use separate ledgers.

Goobi has no production server, account system, advertising SDK, or product-analytics service. The developer does not receive this locally stored data.

On LinkedIn, clicking **Copy & review** immediately writes a local Commented activity mark and removes the opportunity from Goobi's queue. This is a workflow shortcut based on the user's click, not verification that LinkedIn received or published the comment; the mark can be undone from the LinkedIn dock.

## Data sent to Anthropic

Claude features use the Anthropic API directly with the API key supplied by the user. Opportunity analysis uses Claude by default; when Jev-only analysis is enabled, those requests go only to TypeSafe. Comment drafting remains on Claude. Depending on the action, Goobi sends:

- public X post text, author handles, the saved focus, and saved product names/descriptions for reply-opportunity scoring while the X copilot is enabled;
- post text visible in the user's LinkedIn feed, displayed author names, bounded visible headline/person-or-company/connection-label context, the saved focus, and the user-written LinkedIn comment thesis for person/post/contribution scoring while the LinkedIn copilot is enabled;
- selected public post/context, saved voice examples, the user-authored SOUL.md, optional product context, a bounded selection of cached original X posts matching the saved account (with dates, for continuity of experience and positions), and user steering when the user requests a reply draft;
- selected LinkedIn feed post/context, the same bounded author context and comment thesis, Goobi's person/post/contribution guidance, saved conversation focus, shared voice, optional LinkedIn-specific voice notes/examples, SOUL.md, a bounded selection of cached original X posts matching the saved account (with dates, for cross-platform continuity), and user steering when the user requests a LinkedIn comment draft; redrafting also sends the user's edited draft, and an optional Real detail is sent only for that draft and is not stored;
- public source posts, recent public posts from the user's account, niche, voice, SOUL.md, follower tier, and active growth-strategy brief when the user requests Post ideas or rewrites one;
- the selected public relationship context, saved voice, intent, and DM context the user has entered when the user requests a DM draft;
- tab titles, URLs, identifiers, and idle timing when the user explicitly enables and invokes Claude-powered tab grouping, cleanup, or archive search.

LinkedIn author profile-image URLs and canonical visible `/in/` or `/company/` paths may be read from the visible post. Images render only in the local Goobi card and are neither sent nor stored. The normalized profile path is retained only as an author-spacing key in local Commented activity and is not sent to Anthropic. Goobi does not open or fetch author profiles.

The extension does not send browser cookies, X or LinkedIn passwords, native X direct-message inbox contents, LinkedIn messages, or an automatically read private-message history. SOUL.md is not sent with DM drafting. Anthropic processes API data under the terms and settings of the user's Anthropic API account. See the [Anthropic Privacy Center](https://privacy.anthropic.com/).

## Optional data sent to TypeSafe (Jev)

**Jev-only analysis** is off by default and has its own disclosure opt-in. When enabled, visible X/LinkedIn posts, quoted context, displayed author metadata, shared conversation focus, and LinkedIn thesis go to `api.typesafe.ai` during opportunity scans. Jev chooses fit, risk, an observed excerpt, and a predefined contribution direction; it does not write comments. This analysis does not send SOUL.md, personal facts, drafts, voice samples, own-post history, product descriptions, DMs, or browser history. Analysis errors do not fall back to Anthropic. Turn the toggle off to return analysis to Claude.

Jev comment review requires its own TypeSafe API key and a separate disclosure opt-in. It is off by default. In observation mode, each explicitly requested X reply or LinkedIn comment draft/redraft sends the selected post and context, final draft, SOUL.md, explicitly supplied personal facts (including a transient LinkedIn Real detail when supplied), and bounded own-post history to `api.typesafe.ai`. It does not receive voice samples, ambient feed scans, DMs, or browser history. TypeSafe processes this data under the user's API account terms; see [TypeSafe's policies](https://docs.typesafe.ai/legal).

The feature records up to 50 local metadata-only observations: platform, time, model, latency, input-token count, potential-issue labels, or a sanitized error code. It does not store post text, draft text, profile material, or Real detail in this log. Observation mode never changes or blocks a comment; model judgments are not verified mistakes. Turn it off, clear its summaries, or disconnect it from the Jev analysis settings. Turning it off or disconnecting cancels active comment work and stops future Jev requests.

## Data sent to RapidAPI and the X-data provider

If the user supplies a RapidAPI key and invokes an X-data feature, Goobi sends public X handles, search queries, and endpoint parameters to the configured `twitter241` RapidAPI provider. Returned public profile and post data is used for follower counts, recommendation context, Targets, public DM research, own-post measurements, and outcome learning. The feature is optional and governed by the user's RapidAPI subscription and the provider's terms.

## How the data is used

Goobi uses data only to provide the visible extension features the user enables: tab organization, X recommendations and learning, LinkedIn comment recommendations and drafting, account-safety feedback, and relationship workspaces. It does not sell data, use it for advertising, build unrelated profiles, or allow the developer to read private user content.

Goobi's use of information obtained through Chrome APIs is limited to providing and improving its disclosed user-facing features and follows the Chrome Web Store User Data Policy's Limited Use requirements.

## Retention and deletion

Local data remains until the user clears it, removes individual saved items where controls are available, clears the extension's site data in Chrome, or uninstalls the extension. Growth daily snapshots are automatically bounded to 90 days and completed strategy history to 12 experiments. API providers may retain transmitted data under their own policies and the user's account arrangements.

Removing the Anthropic or RapidAPI key stops future calls to that provider. Turning off a social copilot stops that platform's processing after the open X or LinkedIn page is reloaded.

## Security

External requests use HTTPS. API keys are stored in Chrome local extension storage and are sent only to the provider they authenticate. Keys are not bundled in the extension or placed in an X or LinkedIn page.

## Contact and publication note

Private-beta users should contact the person or organization that supplied their build. Before a public store listing, the publisher must replace this paragraph with a stable support/privacy contact and host this notice at the URL entered in the Chrome Web Store Developer Dashboard.
