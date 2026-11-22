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

A second session (2026-11-22) looped the same way. Its `checkpoint`
call carried a `data` JSON string whose prose said "Formal
.opencode/supervisor/approvals.json entry absent". That mention was
blocked. The block reason told the agent to "Ask the engineer to
update .opencode/supervisor/approvals.json", so the agent asked for
a waiver entry (in a schema the supervisor does not read), wrote the
path into its retry, and was blocked again. The workspace had no
supervisor directory, approvals file, or gate at all.

## What Changes

- FR-108 (new): a glob last segment stands for `approvals.json` only
  when the directories before it can name the supervisor directory:
  none (a bare glob), a suffix of `opencode/supervisor`, any path
  ending in `opencode/supervisor`, or a path holding a `**` segment.
  Glob semantics apply to those directories too. `opsx/*` and
  `docs/*.json` no longer match; `supervisor/*`,
  `.opencode/su*ervisor/app*vals.json`, `**/app*.json`, and `*` still
  do. Exact `approvals.json` still matches in any directory.

- FR-109 (new): protected-state block reasons say which argument
  named the protected state, that no approval or approvals entry
  unblocks the call, and to remove the path and retry (or describe
  it in words). They no longer print the protected path, so the
  agent has nothing to echo into its next call.
- FR-110 (new): for tools other than OpenCode builtins, a string
  argument holding whitespace is prose. It is checked as one whole
  path, not split into path tokens, unless its key is a shell-style
  key (`command`, `cmd`, `script`, ...). Builtins, bash, and
  whitespace-free values keep the full token scan. This reverses the
  round-5 "payload keys can false-positive" residual for custom and
  MCP tools.

## Capabilities

### Modified Capabilities

- `supervisor-config`: FR-108, FR-109, FR-110 (protected-state
  check, next to FR-061 and FR-107).

## Impact

- Code: `src/tool-guard.ts` (`hasProtectedSegmentRun` takes the
  protected file's home directory; `checkProtectedState` passes it
  for `approvals.json`).
- Tests: `test/gates.test.ts`.
- Docs: README protected-state paragraph, CHANGELOG.
- `checkProtectedState` builds its path lens per argument key, so
  the reason can name the key.
- Residual (FR-110): a custom tool that takes several paths in one
  space-separated string under a non-shell key is checked as one
  path. The block is defense in depth, not a sandbox; builtins and
  bash are unchanged.
- The other file runs already carry their directory in the run, so
  they are unchanged. The `.opencode/supervisor` directory backstop
  is unchanged.
