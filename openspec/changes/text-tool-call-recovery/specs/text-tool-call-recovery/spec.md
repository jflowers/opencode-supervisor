# text-tool-call-recovery

## ADDED Requirements

### Requirement: FR-090 detect a tool call written as text

When a supervised session goes idle, the supervisor MUST read the
session's last message and, when it is an assistant message
without an error whose last text part has no tool part after it,
MUST detect text shaped like a tool call naming a registered tool
id. Shapes: `<invoke name="…">` (alone or in `<function_calls>`),
`<tool_call>` with a JSON object carrying `"name"` or a leading
tool name, and a bare `{"name": "…", "arguments": …}` object.
Matches inside fenced code blocks or inline code MUST be ignored,
and a name that is not a registered tool id MUST NOT match.

#### Scenario: invoke block detected

- **GIVEN** the last assistant text ends with
  `<invoke name="question">…</invoke>`
- **AND** `question` is a registered tool
- **WHEN** the session goes idle
- **THEN** a text tool call for `question` is detected

#### Scenario: fenced example ignored

- **GIVEN** the same block appears only inside a fenced code block
- **WHEN** the session goes idle
- **THEN** nothing is detected

#### Scenario: real tool part after the text

- **GIVEN** the last assistant message has a tool part after the
  text part
- **WHEN** the session goes idle
- **THEN** nothing is detected

### Requirement: FR-091 steer the session to make the call

On detection the supervisor MUST send one synthetic text message
into the session through `session.promptAsync`, naming the tool
and asking for the actual tool call without repeating the text.
The supervisor MUST NOT run the parsed call itself.

#### Scenario: correction delivered

- **GIVEN** a detected text tool call for `question`
- **WHEN** the check completes under the bound
- **THEN** `promptAsync` receives one synthetic message naming
  `question`

### Requirement: FR-092 bounded corrections in a row

Corrections MUST be bounded to `textToolCall.maxPerSession` in a
row per session (default 2). A check that finds nothing, or a
human-typed user message, MUST reset the run. At the bound the
supervisor MUST NOT steer and MUST log a warning, leaving the
session idle.

#### Scenario: cap reached

- **GIVEN** two corrections in a row with the default bound
- **WHEN** a third idle turn ends with a text tool call
- **THEN** no message is sent and a warning is logged

### Requirement: FR-093 side sessions and duplicate idles

The supervisor MUST NOT check its own side sessions. A message
already checked MUST NOT be checked again, so the two idle
notifications of one turn steer at most once.

#### Scenario: double idle

- **GIVEN** `session.idle` and `session.status` idle for one turn
- **WHEN** both reach the plugin
- **THEN** at most one correction is sent

### Requirement: FR-094 configuration

`textToolCall.enabled` (default `true`) and
`textToolCall.maxPerSession` (default 2) MUST resolve through the
plugin's precedence chain, with environment overrides
`OPENCODE_SUPERVISOR_TEXT_TOOL_CALL` (`true`/`false`) and
`OPENCODE_SUPERVISOR_TEXT_TOOL_CALL_MAX`. Config files MUST
reject wrong-typed values. With `enabled: false` no check runs.

#### Scenario: disabled

- **GIVEN** `OPENCODE_SUPERVISOR_TEXT_TOOL_CALL=false`
- **WHEN** a turn ends with a text tool call
- **THEN** nothing is sent

### Requirement: FR-095 logging and fail-open

Each detection, correction, and capped skip MUST be logged
through the plugin logger. Failures (message fetch, tool list,
delivery) MUST fail open: no throw from the hook, no correction,
and a failed delivery MUST NOT count toward the bound.
