# Design

## Context

The FR-066 pattern grammar is one-directional: a wildcard- or
`$var`-bearing *call* token passes on a verbatim pattern mention
or a trace reference its pattern matches
(`globPathMatches`, `findUnreferencedPath`), but a concrete call
token needs a full-path or basename substring. The FR-067 wait
re-runs the guard after in-flight audits settle and fails open
on timeout up to `maxTimeoutFailOpens` (3). Field session
ses_e72a74b18ffeOU3uNACKZ9k1Jz showed both designs failing bulk
workflows: glob-form reasoning satisfied nothing, and the
corrective loop could not close inside a turn.

## Goals

- Let path-scoped glob reasoning cover the concrete writes it
  describes (FR-069).
- Let the guard see and honestly report the state of in-flight
  audits (FR-070, FR-067).

## Non-Goals

- Crediting raw unaudited reasoning generally — the trace stays
  verified-only; FR-069 only compiles the reverse direction of
  the existing FR-066 token grammar.
- Raising `maxTimeoutFailOpens` or changing its semantics for
  uncovered waits.
- Stripper or narrative-mode changes.
- Fixing the sibling workflow's path-doubling bug (separate
  effort; the guard's blocks there were correct).

## Decisions

### D1 Trace-side satisfaction is compiled, not substring

A concrete token that fails full/basename matching tests the
trace's pattern tokens (the lazy `traceTokens` array already
built for the FR-066 direction): each pattern token that is
path-scoped is matched against the concrete token's full
lowercased path and every slash-boundary suffix of it in one
dynamic-programming pass. Suffixes bridge absolute tool
arguments against relative reasoning spellings. Matching is
case-insensitive, matching every other comparison in the check.
(Amended during implementation review, iterations 1-3: the
original design compiled globs to regular expressions via
`globPathToRegExp`; that compiler was replaced by a total,
bounded DP matcher, `globPathMatches`, which parses each
pattern once (`compileGlobPattern`), answers every suffix in a
single table pass (`globTokensMatchAnySuffix`), and charges all
matches in one call against an aggregate work budget
(`MAX_GLOB_BUDGET_CELLS`, 4M DP cells) that fails closed, so
agent-authored pattern counts cannot multiply the work. Neither
matcher compiles untrusted input to a RegExp. Iteration 4
tightened the same budget: every scanned pair — DP cells and
pair sweeps alike — is charged against it, the DP table is a
flat `Uint8Array`, and an exhausted budget surfaces as a
distinct `budgetExhausted` block reason rather than a silent
non-match.)

### D2 Path-scoped guardrail

A trace pattern must contain at least one `/` to satisfy a
concrete token. `kb/topics/*.md` covers `kb/topics/gov-ci.md`;
`*.md` and `post-review.*` cover nothing. This mirrors the FR-066
rejection of cross-segment `**` (a bare `.md` mention must not
dissolve the filename-level check) and keeps trust symmetric
with the existing verbatim-pattern pass.

### D3 pendingAudits carries step tokens

`pendingAudits` becomes `Map<Promise<unknown>, string[]>` — each
in-flight continuation registered with the path tokens of the
stripped step it is auditing. Registration stays SYNCHRONOUS with
the dispatch: FR-067's wait contract requires a racing tool call
to see the pending audit the moment the part completes, and
hoisting the async `buildConfig`/`stripNarrative` above
registration would delay that registration and reopen the
partial-trace race. The entry is therefore a mutable token box
the continuation fills once the strip resolves; a waiter reading
before the fill sees no coverage (fail-closed, and in practice
the strip finishes long before the 10 s wait bound); a strip
failure falls to the outer catch, failing open exactly as today.
Tokens use the shared grammar, so "the step names the path" and
"the guard demands the path" agree by construction.
(Implementation-review amendment: an earlier draft of this
decision described the hoist; the shipped mechanism is the box.)

### D4 Covered timeouts charge a separate bounded budget

When the unmatched token is named by an in-flight audit's step
tokens (a covered wait), a timed-out wait fails open against
`maxCoveredTimeoutFailOpens` (default 6, full precedence chain,
config-file validated) instead of `maxTimeoutFailOpens`, and is
logged distinctly; past the cap it blocks naming the audit. The
security learning on FR-067 applies — the supervised party can
manufacture this trigger (name the path, stall the audit), so it
must be bounded — but generously: each covered fail-open also
ends an honest retry loop, and the path was explicitly reasoned.
Coverage reads the PRE-WAIT snapshot deliberately (review
iteration 2): an audit in flight when the wait began confers
covered relief for that wait even if it settles before the
timeout — the correction was reasoned before the call blocked,
which is what relief is for. Uncovered waits are unchanged.
Reward-hacking and directive checks never charge any wait.

### D5 Eviction detection by snapshot diff

Before the wait the hook snapshots the pendingAudits entries;
after a settled wait that still blocks, any departed entry whose
tokens covered the unmatched token means the correction was
audited and not recorded. The reason then says so — the recent
reasoning named the path but its audit did not pass — directing
a factual restatement instead of the generic instruction. Pure
reason-text change: no verdict semantics move.

### D6 Reasons name the real corrective action

The plain not-in-trace reason names both accepted forms — the
explicit full path or basename, or a path-scoped pattern
covering it — and directs retry after the audit settles rather
than in the same turn. The instruction is honest in both states
(audit pending or not), so `verifyToolIntent` keeps its pure
signature.

## Risks / Trade-offs

- FR-069 widens what satisfies the check: one path-scoped
  pattern mention covers every matching write. Bounded by D2 and
  by the FR-066 trust symmetry (a verbatim pattern mention
  already passed pattern-form calls).
- D4 reopens a bounded slice of the manufactured-pending-audit
  bypass closed by FR-067's cap. Bounded, logged, and the
  reward-hacking fence plus the path ledger still apply.
- The Map migration touches existing tests that use the Set API.

## Open Questions

None — both trade-offs were decided with the engineer (separate
bounded cap; eviction detection in scope).

## Rollback

All changes live in `src/tool-guard.ts`, `index.ts`, and
`src/config-file.ts` behind the existing flags; reverting the
commits restores FR-066/FR-067 behavior. The new knob is inert
without the covered-wait branch.
