# First-run X setup

Fresh installs open a welcome tab. The side panel also resumes unfinished setup;
**Guided X setup** reopens it from Conversations. Updates do not open welcome tabs
or change an existing user's provider, consent, keys, or copilot state.

1. **Choose your setup.** Jev analysis with Claude replies is recommended. Claude-only
   analysis is also available. Both use your own API account; provider usage is billed
   separately. RapidAPI, LinkedIn, voice learning, and optional draft review are not
   required for the basic X flow.
2. **Connect your providers.** Enter an Anthropic key, plus a TypeSafe key for Jev.
   Read and accept X data use and, when choosing Jev, its separate analysis disclosure.
   Saving a key does not perform a paid credential test. A saved key has not been
   verified with its provider.
3. **Pick your focus.** Describe the topics and conversations you want to join.
   Voice notes are optional. Save to continue; completed steps resume after closing
   the panel. Unsaved fields must be entered again.
4. **Make your first reply.** Review the short walkthrough, then choose **Enable Goobi
   + open X**. Browse a few posts, open Goobi's dock, choose a reply spot, draft, copy,
   and manually review/post on X. Copying alone does not prove a reply was posted.

X scanning stays off during provider setup and begins only after the final enable
action passes the current key, consent, and focus checks. Goobi opens a fresh X tab
so the current content script loads. Existing X tabs should be refreshed after an
extension update. Jev analysis also applies to LinkedIn if the user has separately
enabled that copilot; onboarding does not enable LinkedIn or Jev draft review.

## Implementation and verification

`lib/x-onboarding.ts` owns setup transitions and readiness. The only onboarding
metadata is version, stage, selected setup, and completion state. Keys remain in
their existing Chrome local storage entries and never appear in onboarding HTML.
`popup/x-onboarding.ts` renders the guide and handles its explicit save actions;
`popup.ts` hosts it and opens X. The install listener opens the existing bundled
`popup.html` only for new installs needing setup.

The zero-cost onboarding suite covers fresh installs, resumption, consent and key
gates, provider choices, and preservation of existing settings. Manual verification
should also use a clean Chrome profile and complete scan → draft → copy on X with
the tester's own provider keys. No public-store release is implied by setup completion.
