# Design

## Context

`session.idle` (and `session.status` idle) already reaches the
`event` hook for guard profiles (FR-072). Tool ids per
provider/model are already fetched and cached for arg repair
(`fetchToolSchemas`). Critiques already steer through
`session.promptAsync` with a synthetic text part.

## Decisions

### D1: Pure detector, tool-id gated

`src/text-tool-call.ts` exports `detectTextToolCall(text,
toolIds)`, returning `{ tool, shape }` or `null`. Code is masked
first: fenced blocks (``` and ~~~, closed or running to the end)
and inline backtick spans become blanks, so prose about tool calls
never triggers. A match counts only when its tool name is in
`toolIds` (case-sensitive, as ids are). Shapes, first match wins:
`invoke` (`<invoke name="x">`, optional namespace prefix, also the
`<function_calls>` wrapper), `tool_call` (`<tool_call>` followed
by a JSON object with `"name"`, or by a bare tool name as in the
GLM template), and `json` (`{"name": "x", "arguments": …}`).

Rejected: parsing and running the call (out of scope, bypasses
the guard and repair); matching any tag without a registered tool
(false positives on prose about XML).

### D2: Which message is checked

`assessLastTurn(messages, toolIds)` takes the session's message
list. Only the last message counts, and only when it is an
assistant message without an error (an aborted or failed turn is
not ours to resume). The last `text` part is checked; a `tool`
part after it means a real call happened, so nothing is done.

### D3: Tool ids

The ids come from `fetchToolSchemas` for the session's model
identity (captured from `chat.message`, else the assistant
message's `providerID`/`modelID`), plus the plugin's own console
tools. When the list is unavailable, the check skips (fail open).

### D4: Bound and dedupe

`state.textToolCallStreak` counts corrections in a row. A clean
check (no detection) or a human-typed user message resets it;
synthetic messages (our steer) do not. At `maxPerSession` the
check logs one warning per message and does not steer, so the
session stays idle (gh-hud#9 notices). `state.textToolCallChecked`
holds the last message id checked: `session.idle` and
`session.status` idle both fire per turn, and the second sees the
same message. An in-flight flag set before any await keeps two
concurrent idle events from both steering. The streak slot is
reserved before the `promptAsync` await and released when
delivery fails.

### D5: Full mode only

Repair-only mode keeps its contract (only the arg-repair pass is
registered), so the `event` hook stays unregistered there.

### D6: Config

`textToolCall: { enabled: true, maxPerSession: 2 }` resolves
through session → env → project file → options → global file →
default. It is not a guard, so `lockGuards` does not touch it.

## Risks

- A message that quotes a tool call outside code, naming a real
  tool, gets one steer. The message says not to repeat the text,
  and the cap bounds repeats.
- `promptAsync` accepted is not delivered (spike 1.2); a server
  side failure surfaces as an error event, an accepted gap.

## Rollback

Set `textToolCall.enabled: false` (or the env knob), or revert.
