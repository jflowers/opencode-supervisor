# Proposal

## Why

A live `/address-feedback` run on fullsend-ai/fullsend (supervisor
2.14.0, opencode 1.19.0) had `dispatch_review_runs` blocked as
touching the approvals file. The call never named it. Its free-text
`review_context` argument said "no speckit/NNN-* or opsx/* match",
and the path extractor read `opsx/*` as a path. FR-107 lets a glob
in the last segment stand for `approvals.json`, so `*` matched the
file name no matter which directory came before it.

The agent read the block as a missing approval and asked the
engineer to add `dispatch_review_runs` to `approvals.json`, which
cannot unblock it. The required review dispatch stalled.

## What Changes

- FR-108 (new): a glob last segment stands for `approvals.json` only
  when the directories before it can name the supervisor directory:
  none (a bare glob), a suffix of `opencode/supervisor`, any path
  ending in `opencode/supervisor`, or a path holding a `**` segment.
  Glob semantics apply to those directories too. `opsx/*` and
  `docs/*.json` no longer match; `supervisor/*`,
  `.opencode/su*ervisor/app*vals.json`, `**/app*.json`, and `*` still
  do. Exact `approvals.json` still matches in any directory.

## Capabilities

### Modified Capabilities

- `supervisor-config`: FR-108 (protected-state check, next to FR-061
  and FR-107).

## Impact

- Code: `src/tool-guard.ts` (`hasProtectedSegmentRun` takes the
  protected file's home directory; `checkProtectedState` passes it
  for `approvals.json`).
- Tests: `test/gates.test.ts`.
- Docs: README protected-state paragraph, CHANGELOG.
- The other file runs already carry their directory in the run, so
  they are unchanged. The `.opencode/supervisor` directory backstop
  is unchanged.
