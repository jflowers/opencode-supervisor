# Design

## Context

OpenCode 1.18's task tool (`packages/opencode/src/tool/task.ts`)
runs the subagent prompt to completion and returns
`renderOutput({ sessionID, state: "completed", text })`, where
`text` is the last text part of the subagent's final message:

```text
<task id="ses_…" state="completed">
<task_result>
…final text…
</task_result>
</task>
```

Its metadata carries `sessionId` (the subagent session),
`parentSessionId`, `model`, and `background: true` for background
runs. `session/tools.ts` (and the command subtask path in
`session/prompt.ts`) triggers `tool.execute.after` with that
output object and then returns the same object, so a hook's edits
to `output.output` reach the parent. The subagent's idle event
carries no such window: by then the result is fixed.

## Decisions

### D1: Correct at the parent's task boundary

`tool.execute.after` gains a `task` branch (full mode, not a side
session, `textToolCall.enabled`). It reads `metadata.sessionId`
and skips when that is missing, when `metadata.background` is
true, or when the output is not a completed task result
(`parseTaskResult` returns null).

Rejected: steering the subagent on idle (FR-093's reason holds);
patching the parent's next turn with a note only (the parent
would still lack the subagent's work).

### D2: Synchronous correction loop

The hook fetches the subagent's last message (`limit: 1`) and
runs `assessLastTurn` with the tool ids for the subagent's model
(its last assistant message's `providerID`/`modelID`). On
detection it calls `session.prompt` (blocking) with the FR-091
synthetic text, passing the subagent's agent (`agent`, else
`mode`, from that message) and model: without them OpenCode would
answer with the default agent. The returned message is assessed
again; the loop ends on a clean turn, an error, or the bound.

The bound is the subagent session's `textToolCallStreak`
(`maxPerSession` in a row). A new task prompt into the subagent is
human-typed text as far as `chat.message` sees it (non-synthetic),
so each task call starts a fresh run; a resumed task shares the
session's state as a root session would.

### D3: Rewrite the parent's result

`replaceTaskResult(output, text)` swaps the body between the last
`<task_result>` and `</task_result>` for the corrected final text;
the frame and the task id stay. When the loop ends with a text
tool call still present (bound reached, delivery failed, or the
corrected turn errored), the last text is kept and
`subagentTextToolCallNote(call)` is appended inside the result so
the parent knows the call never ran.

### D4: Idle path unchanged

The idle check keeps skipping subagent sessions (FR-093); its log
line says the detection is handled at the parent's task boundary.
Any session with a parent counts, including the correction turns
D2 starts, so the idle check never races the loop.

### D5: Fail open

Every failure (message fetch, tool list, prompt) is logged and
leaves `output` as it was, apart from the D3 note once a detection
is confirmed. The hook never throws.

## Risks

- The parent's `task` call waits for up to `maxPerSession`
  correction turns. They do real work (a `question` waits for the
  engineer), which is the point, but the parent stays busy.
- Aborting the parent during a correction does not cancel the
  correction turn: `tool.execute.after` gets no abort signal.
- The result format is OpenCode's, not a contract. If it changes,
  `parseTaskResult` returns null and the branch skips (fail open).

## Rollback

`textToolCall.enabled: false` turns off both paths; or revert.
