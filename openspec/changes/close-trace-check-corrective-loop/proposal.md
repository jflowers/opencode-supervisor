# Proposal

## Why

Field session ses_e72a74b18ffeOU3uNACKZ9k1Jz (bulk knowledge-base
build, plugin defaults) logged 162 tool errors; 150 came from the
file-path trace check. Two structural causes, both guard-side:

1. A one-way pattern valve. FR-066 pattern semantics satisfy
   wildcard-bearing *call* tokens from trace text, but a concrete
   call token passes only on a full-path or basename substring.
   An agent that reasons in path-scoped globs (`kb/topics/*.md`)
   before a batch of concrete writes satisfies nothing — every
   write in the batch blocks. The trace-side token extractor
   already exists for the other direction; the reverse direction
   was never compiled.

2. A corrective loop that cannot close within a turn. The block
   reason says "reason about the file, then retry", but fresh
   reasoning joins the verified trace only after the async peer
   audit settles. Same-turn retries wait 10 s, charge the
   3-fail-open budget, then hard-block repeatedly (one file: 12
   blocks). When the correction IS in flight the guard cannot
   see it, and when a corrected step was audited but evicted the
   reason still blames absent reasoning.

## What Changes

- FR-069 (new): trace-side pattern satisfaction. A concrete
  operational token passes when the verified trace carries a
  path-scoped pattern token (at least one `/`) whose compiled
  glob matches the token's full path or a slash-boundary suffix,
  case-insensitively. Bare filename globs (`*.md`) stay
  insufficient — the mirror of FR-066's cross-segment `**`
  rejection. Concrete full-path/basename matching is unchanged.
- FR-070 (new) and FR-067 (modified): pending-audit awareness.
  `pendingAudits` carries each in-flight audit's stripped-step
  path tokens. A trace block whose unmatched token is provably
  named by an in-flight audit (a covered wait) fails open on
  timeout against a separate bounded per-session cap
  (`maxCoveredTimeoutFailOpens`, default 6, full precedence
  chain), blocking past the cap with the audit named. Block
  reasons become honest: the plain reason names the
  explicit-or-pattern corrective action and says to retry after
  the audit settles; a settled wait whose correction was audited
  but not recorded says so, detected by snapshot diff.

## Capabilities

### Modified Capabilities

- `trace-check`: FR-067 gains covered-timeout relief; FR-069 and
  FR-070 are added.

## Impact

- Code: `src/tool-guard.ts` (FR-069 and reason text), `index.ts`
  (pendingAudits Map with step-token boxes, covered fail-open,
  eviction detection, knob resolution), `src/config-file.ts` (new
  numeric knob), `src/path-tokens.ts` (Set-backed token dedupe,
  review iterations 3-4: O(n²) → O(n) so adversarial token
  volume cannot stall the event hook).
- Specs: `openspec/specs/trace-check/spec.md` is the delta base —
  340 lines syncing FR-062..FR-068 byte-identical from the
  archived `repair-trace-check-pipeline` delta, which had no main
  spec to modify. This change's FR-069/FR-070 additions and the
  FR-067 modification sit in the change delta, as OpenSpec
  requires pre-archive.
- Docs: README trace-check sections and knob table, CHANGELOG,
  AGENTS.md architecture bullets.
- Tests: guard cases for pattern satisfaction; hook-layer cases
  for covered fail-open, eviction reasons, and the Map migration;
  config-file validation for the new knob.
- Risk: bounded. A path-scoped pattern mention now covers
  matching concrete writes at the same trust level as the
  existing verbatim-pattern pass. Covered timeouts reopen a
  slice of the manufactured-pending-audit bypass; they are
  bounded by the new cap, logged, and leave the reward-hacking
  check and the path ledger untouched.
