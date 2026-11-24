# Proposal

## Why

Issue #87. A live run of `opencode-debug-harness` (`/debug`, GLM 5.3,
audit model Muse Spark, opencode 1.19.0, supervisor 2.14.1) got a
false audit finding: "Step 1 edits src/duration.ts before debug_open
succeeds, violating session goal ordering". `debug_open` had
succeeded five tool calls earlier.

Cause: each reasoning part is audited alone. `runPeerAudit` gets
`[stepText]`, numbered "Step 1", plus the session goal. Nothing else
from the session reaches the auditor. The `/debug` goal says "Do not
edit any code before debug_open succeeds", and the audited part
(message 13: "Next step: debug_experiment_start ... Then edit
src/duration.ts") plans an edit. With the goal's ordering rule and a
lone "Step 1" that edits, "edited before debug_open" is the natural
reading. The opencode log shows the audit session created 4 ms after
that part finished; the verdict came 16 s later, after the edit.

## What Changes

- FR-111 (new): every peer audit of a session (reasoning parts and
  `request_audit`) includes the session's completed tool calls so
  far (tool name and short outcome, oldest first, at most 40) under
  a session-progress note. The note says the calls are context, not
  steps to audit; step numbers count only the audited steps; a
  prerequisite listed there has already happened; and a prerequisite
  must not be assumed missing because the steps do not mention it.
  With no completed calls the prompt is unchanged.

Considered and not done: dropping a finding once later tool calls
moved past its step. A later call does not make a true ordering or
logic finding false, so dropping on staleness would also hide real
findings. Giving the auditor the history removes this false finding
where it starts.

## Capabilities

### Modified Capabilities

- `reasoning-audit`: FR-111.

## Impact

- Code: `src/auditor.ts` (`renderSessionProgress`,
  `SESSION_PROGRESS_NOTE`, `AUDIT_PROGRESS_CAP`, a new optional
  `runPeerAudit` argument); `index.ts` (both audit call sites pass
  the session's solved-items log).
- Tests: `test/audit.test.ts`.
- Docs: README 4.1, CHANGELOG.
