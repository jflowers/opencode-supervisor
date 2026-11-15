# text-tool-call-recovery

## MODIFIED Requirements

### Requirement: FR-093 side sessions and duplicate idles

The supervisor MUST NOT check its own side sessions. The idle
check MUST NOT steer a subagent session (one with a parent),
since its parent already holds the final text as the task
result; a detection there MUST be logged as handled at the
parent's task boundary (FR-096). A message already checked MUST
NOT be checked again, so the two idle notifications of one turn
steer at most once.

#### Scenario: subagent session on idle

- **GIVEN** a session whose parent is another session
- **WHEN** it goes idle with a text tool call as its last turn
- **THEN** the detection is logged and no message is sent

#### Scenario: double idle

- **GIVEN** `session.idle` and `session.status` idle for one turn
- **WHEN** both reach the plugin
- **THEN** at most one correction is sent

## ADDED Requirements

### Requirement: FR-096 correct a subagent before its task returns

When a foreground `task` call completes with a completed task
result, the supervisor MUST check the subagent session's last
turn as FR-090 describes. On detection it MUST prompt the
subagent synchronously with the FR-091 correction, under the
agent and model of the subagent's last assistant message, and
MUST check the turn that results again. Corrections MUST be
bounded to `textToolCall.maxPerSession` in a row per subagent
session. The supervisor MUST NOT run the parsed call itself.

#### Scenario: subagent corrected

- **GIVEN** a subagent whose final text is
  `<invoke name="question">…</invoke>`
- **AND** `question` is a registered tool
- **WHEN** the parent's `task` call completes
- **THEN** the subagent receives one synthetic correction naming
  `question`, with its own agent and model

#### Scenario: clean subagent

- **GIVEN** a subagent whose final text has no text tool call
- **WHEN** the parent's `task` call completes
- **THEN** no prompt is sent and the output is unchanged

### Requirement: FR-097 the parent receives the corrected result

After a correction, the `task` output MUST carry the subagent's
new final text in place of the original `<task_result>` body,
keeping the surrounding frame. When the correction loop ends with
a text tool call still present, the result MUST keep the last
text and MUST append a supervisor note naming the tool call that
never ran.

#### Scenario: result rewritten

- **GIVEN** a corrected subagent whose new final text is `Done.`
- **WHEN** the `task` output reaches the parent
- **THEN** its `<task_result>` body is `Done.`

#### Scenario: bound reached

- **GIVEN** a subagent that writes the call as text again after
  every correction
- **WHEN** the bound is reached
- **THEN** no further prompt is sent and the result carries a
  note naming the tool

### Requirement: FR-098 scope and fail-open at the task boundary

Background `task` calls, `task` outputs that are not a completed
task result, side sessions, repair-only mode, and
`textToolCall.enabled: false` MUST be left alone. Failures
(message fetch, tool list, prompt) MUST be logged and MUST NOT
throw from the hook; before a detection the output MUST stay
unchanged.

#### Scenario: background task

- **GIVEN** a `task` call with `metadata.background` true
- **WHEN** it completes
- **THEN** no message is fetched and the output is unchanged

#### Scenario: correction fails

- **GIVEN** a detected subagent text tool call
- **WHEN** the correction prompt fails
- **THEN** the hook does not throw and the result carries the
  note
