# Proposal

## Why

Text tool-call recovery (FR-090..FR-095, 2.11.0) corrects root
sessions only. A subagent session's detection is logged and left
alone (FR-093), because by the time the subagent goes idle its
final text has already become the parent's `task` result: OpenCode's
task tool returns the last text part of the subagent's final
message, so a steer on idle would run a turn nobody reads.

That leaves subagents unprotected, and they are where long
workflows run. A subagent that ends with
`<invoke name="question">…</invoke>` hands its parent a result that
is a tool call nobody made, and the parent carries on as if the
work were done.

The timing limit is real, but there is a window before it:
OpenCode triggers `tool.execute.after` for the `task` call after
the subagent's turn ends and before the result reaches the parent,
and it returns the hook's (mutable) output object. The supervisor
can correct the subagent there and hand the parent the corrected
result.

## What Changes

- FR-096 (new): when a foreground `task` call completes, the
  supervisor checks the subagent session's last turn with the
  FR-090 detector. On detection it prompts the subagent
  synchronously (`session.prompt`) with the FR-091 correction,
  under the subagent's own agent and model, and checks the new
  turn again, bounded by `textToolCall.maxPerSession` per subagent
  session in a row.
- FR-097 (new): the `task` output the parent receives carries the
  subagent's corrected final text in place of the original
  `<task_result>` body. When the subagent still ends with a text
  tool call at the bound, or a correction fails, the parent's
  result keeps the last text and gains a supervisor note naming
  the tool call that never ran.
- FR-098 (new): background task calls, task calls whose output is
  not a completed task result, and plugin side sessions are left
  alone; every failure fails open with the original output.
- FR-093 (modified): the idle path still never steers a subagent
  session; its detection is logged as handled at the parent's
  task boundary.

Out of scope: background subagents (their result is injected into
the parent later, outside any hook) and cancelling a correction
turn when the parent's call is aborted (the hook has no abort
signal).

## Capabilities

### Modified Capabilities

- `text-tool-call-recovery`: FR-093 modified; FR-096..FR-098
  added.

## Impact

- Code: pure helpers in `src/text-tool-call.ts` (task-result
  parsing and rewriting, the parent note); the `task` branch of
  `tool.execute.after` and the subagent correction loop in
  `index.ts`.
- Tests: `test/text-tool-call.test.ts` (helpers; hook-layer
  correction, rewrite, bound, background, failure, disabled).
- Docs: README §4.7, CHANGELOG, AGENTS.md.
- Risk: the parent's `task` call waits for the correction turns
  (at most `maxPerSession`), which do real work such as asking a
  question.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The subagent makes its own call with its own arguments; the parent
receives the subagent's real result instead of an unexecuted call.

### II. Composability First

**Assessment**: PASS

No new knob or dependency: the existing `textToolCall` settings
govern both paths. The correction reuses the documented session
prompt API and the hook OpenCode already exposes.

### III. Observable Quality

**Assessment**: PASS

Each detection, correction, and capped result is logged, and an
uncorrected result tells the parent so in the result itself.

### IV. Testability

**Assessment**: PASS

The result rewrite is a pure function tested in isolation; the
hook path is tested through mocked clients.
