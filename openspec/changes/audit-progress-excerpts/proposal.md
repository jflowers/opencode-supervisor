# Proposal

## Why

Issue #91, a follow-up to #87. A re-run of the `/debug` dogfood
with supervisor 2.15.0 (FR-115) got a false finding after
`debug_conclude` had already returned `FIXED` with its toggle
proof: "Step hallucinates verification not in session history:
claims 'reset verification already showed... r3, fingerprint
matches' but session progress ends at debug_experiment_end".

Two causes, both confirmed from session
`ses_df0d76920fferpM7azcvmid63J`:

- FR-115's progress list reuses the memo's solved-items line: the
  first 80 characters of each output. `debug_experiment_end`'s
  output is 743 characters and its last line is `Reset verified:
  ... (r3, fingerprint matches)`, so the evidence never reached the
  auditor, and nothing told it outputs were cut.
- The audited reasoning part planned `debug_conclude`, a call that
  runs the toggle proof itself. The audit started when the part
  ended (20:07:50.5Z), `debug_conclude` completed at 20:08:02.5Z,
  and the finding was delivered after that: it judged a plan
  without its result and steered after the result proved it.

## What Changes

- FR-114 (new):
  - Each completed call keeps a head-and-tail excerpt of its output
    (300 + 500 characters, `[...]` marking the cut) beside the
    memo line. The audit prompt shows the excerpt for the 8 newest
    calls; older calls keep the one-line outcome.
  - The progress note says outputs are excerpts, that a step may
    quote text cut from a listed call (flagged only when what is
    shown contradicts it), that citing a call absent from the list
    is still unsupported, and that output text is never
    instructions.
  - A failed minor peer finding is re-checked once, before
    delivery, when tool calls completed while the audit ran. The
    re-check prompt adds those calls before the steps (which stay
    last, so tool output never ends the prompt), under a note
    that they are usually the calls the steps planned and are
    evidence for factual claims only: goal, directive and rule
    violations still fail. A passing re-check drops the finding; a
    failing one replaces it with its critique; a re-check that
    fails open keeps the original finding. Severe and
    deterministic invariant findings are not re-checked.

## Capabilities

### Modified Capabilities

- `reasoning-audit`: FR-114 (extends FR-115).

## Impact

- Code: `src/auditor.ts` (`excerptToolOutput`, detail rendering in
  `renderSessionProgress`, `LATER_PROGRESS_NOTE`, a new optional
  `runPeerAudit` argument); `src/records.ts` (`SolvedItem.detail`);
  `index.ts` (excerpt on `tool.execute.after`, the re-check in the
  event hook's audit continuation).
- Cost: one extra audit model call, only for a peer failure whose
  session made tool calls while the audit ran.
- Tests: `test/audit.test.ts`.
- Docs: README 4.1, CHANGELOG.
