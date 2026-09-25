# Commenting systems: priorities and reliability

The core product is the loop from a worthwhile conversation to a specific, grounded contribution.
X and LinkedIn share request infrastructure while retaining their own opportunity rules, voice
guidance, consent, and activity history.

See [Choosing posts and contributions](comment-selection.md) for the implemented selection and
draft-grounding rules and their evaluation limits.

## What matters most

1. **Choose the right person and post.** X combines content fit with observed thread opportunity;
   LinkedIn requires person fit, post fit, and a credible contribution. A model score is guidance,
   not a platform ranking probability or a promise of reach.
2. **Carry the exact evidence into the draft.** Post identity, author context, quoted material,
   the selected contribution, and the current user settings must stay consistent across async work.
   A late result from a previous account, thesis, or draft choice must not replace current work.
3. **Produce a useful comment in the user's voice.** Voice is style evidence; personal claims require
   factual grounding. LinkedIn enforces required Real detail before requesting a draft and can make
   one targeted quality repair. Partial or refused model output is not a finished draft.
4. **Keep review dependable.** Errors and retries should preserve edits. Both platforms copy for
   manual review/posting. X counts an explicit posting confirmation; LinkedIn's existing Copy & review
   shortcut records a local Commented mark, which is not platform verification.
5. **Learn from evidence.** X has measured reply outcomes and sample-gated learning. LinkedIn currently
   has local activity and relationship spacing, without platform outcome measurement.

## Request boundary

The service worker validates the sender and bounded payload, then reads current consent, enablement,
pause state, and configuration. X accepts only supported X content-script senders for scoring and
reply drafting; LinkedIn accepts its supported feed/post surfaces. Their gates are independent.

A cancellation controller is registered before reading configuration. Changes to consent, keys,
pause, or relevant scoring/voice settings cancel the affected platform's queued and active model work.
Shared voice, focus, and SOUL changes affect both; LinkedIn-specific settings do not cancel X work.
Content scripts independently reject results invalidated by navigation, settings, or draft selection.

All Claude HTTP attempts share `claude-request-governor.ts`: two active requests, up to eight waiting,
a 15-second queue deadline, and a 25-second transport deadline including response-body consumption.
Overload/rate-limit responses establish a shared cooldown and reject waiting work. The governor does
not replay failed paid generations automatically. Existing compatible-model fallback and LinkedIn's
single quality repair remain separate, bounded application decisions and honor cancellation.

These limits apply to individual HTTP attempts. A fallback or quality repair can make a logical
generation longer. Aborting a local request cannot guarantee a provider stops work it already received.
Queue and cooldown state live in the current service worker; this is not a durable monthly spend cap.

## Failure and retry behavior

- X validates complete discovery batches, including global indices across chunks, and suppresses stale
  draft/discovery responses after context changes. Its broker preserves an explicitly empty product
  selection, so choosing no product cannot fall back to saved promotional context.
- LinkedIn latches scoring failures instead of draining the rest of the queue into the same provider
  error. Retry scan keeps approved opportunities, edited drafts, and personal details. An explicit
  fresh rescan remains a separate session reset.
- Pausing or changing settings while the worker is reading its profile cannot dispatch the old request.
  Changing settings during a fetch aborts the transport and prevents accepting that result.

## Verification and remaining work

`test-comment-broker.mjs` executes the bundled worker with mocked Chrome/model boundaries.
The X and LinkedIn workflow suites execute production functions with controlled timers and callbacks;
the Claude suites exercise scheduling, cancellation, provider failures, and output completeness.

Live feed selectors and model quality still require separate browser/provider evaluation. Useful
quality measures are post/author correctness, factual grounding, draft acceptance, edits required,
and repeated/generic phrasing. Outcome claims should remain tied to actual platform evidence.

The next persistence improvement is a single durable writer for X reply activity. Current cross-tab
in-memory merging is not a transaction and does not guarantee the merged ledger survives a restart.
That migration is separate from this commenting request/lifecycle hardening.
