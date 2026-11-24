# Proposal

## Why

unbound-force/unbound-force#1199: `uf_delegate_command` and
`invoke_agent` run a child session made with
`session.create({ parentID })` and wait on a blocking
`session.prompt`. In the macbook's opencode.db, child session
`ses_df1d28108ffeOxknDVhurdmW8K` (agent `cobalt-crush-dev`, model
Muse-Spark) received a `[supervisor] audit finding` message at
15:30:55 with agent `build` and model `glm-5-3`. The child's last
reply came from build/glm, so the caller failed with
`model_mismatch`. Three of the four recent cobalt-crush
`MessageAbortedError` failures were followed at once by a
supervisor steer on build/glm-5-3: the severe-finding path.

Two faults in critique delivery (FR-007/FR-008):

1. It aborts and steers any session, including subagent sessions.
   The abort resolves the parent's blocking `session.prompt` with
   `MessageAbortedError`, and the caller loses the child's report.
   A steer after the parent has read the result runs a turn
   nobody reads. Text tool-call recovery already skips subagent
   sessions for this reason (design D7, FR-093).
2. Every `promptAsync` steer omits `agent` and `model`, so OpenCode
   answers it with the default agent and model, not the session's.

## What Changes

- FR-111 (new): critique delivery skips sessions that have a
  parent. No abort, no steer, no bound slot spent. The critique is
  recorded as withheld (FR-015), so the memo still shows it on the
  child's next turn, and the skip is logged. The tool guard still
  blocks severe findings at execution.
- FR-112 (new): every `promptAsync` steer the plugin sends (audit
  critiques, root-session text tool-call corrections) carries the
  agent and model of the session's latest user message. When
  neither is known the steer is sent without them (old behavior).

## Capabilities

### Modified Capabilities

- `reasoning-audit`: FR-111, FR-112 (next to FR-007, FR-008).

## Impact

- Code: `index.ts` (`createCritiqueDelivery` takes the parent
  resolver and a steer-target resolver; `recoverTextToolCall`
  passes the target).
- Tests: `test/audit.test.ts`, `test/text-tool-call.test.ts`.
- Docs: CHANGELOG.
- Residual: a session whose parent is unknown (no
  `session.created` event seen and `session.get` failed) is
  treated as a root session, as FR-072 already does.
