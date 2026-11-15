# supervisor-tools Specification

## Purpose

Extends the agent console beyond reminders: recall gives the
supervised agent read access to stored supervision state, report
records self-reported events for the engineer, and request_audit
runs the peer audit on demand at a decision point.
## Requirements
### Requirement: FR-033 recall tool

The middleware SHALL offer a `recall` tool to supervised sessions.
The tool SHALL accept a `what` argument with the values `goal`,
`reminders`, `solved`, `critiques`, or `all` (default `all`) and
SHALL return the requested stored state rendered as text. Recall
SHALL return the full stored lists for the session, not the
memo's recency-bounded views.

#### Scenario: Recalls solved items beyond the memo cap

- **WHEN** the session stores more solved items than the memo's
  solved-items cap and the agent calls `recall` with `what` set to
  `solved`
- **THEN** the result lists every stored solved item, including
  entries the memo no longer renders

#### Scenario: Unknown section yields an actionable result

- **WHEN** the agent calls `recall` with `what` set to a value
  outside the supported set
- **THEN** the result states the value is unsupported and lists
  the supported values

#### Scenario: Empty state is reported plainly

- **WHEN** the agent calls `recall` for a section whose stored
  list is empty
- **THEN** the result states that nothing is stored for that
  section

### Requirement: FR-034 report tool

The middleware SHALL offer a `report` tool to supervised sessions.
The tool SHALL accept a `kind` argument with the values `blocker`,
`deviation`, `outcome`, or `note`, and a `text` argument. It
SHALL store the report in session state and return a result that
echoes the stored kind and text.

#### Scenario: Stores a blocker report

- **WHEN** the agent calls `report` with kind `blocker` and a
  non-empty text
- **THEN** the result confirms the report was recorded and echoes
  the text

#### Scenario: Whitespace-only text is rejected

- **WHEN** the agent calls `report` with text that is empty or
  whitespace-only
- **THEN** the result rejects the report with an actionable
  message and nothing is stored

#### Scenario: Over-length text is truncated

- **WHEN** the agent calls `report` with text longer than 2000
  characters
- **THEN** the report stores the first 2000 characters and the
  result says the text was truncated

#### Scenario: Unknown kind yields an actionable result

- **WHEN** the agent calls `report` with a `kind` outside the
  supported set
- **THEN** the result states the kind is unsupported, lists the
  supported kinds, and nothing is stored

### Requirement: FR-035 Report storage bounds

Report storage SHALL keep only the most recent reports for a
session, bounded by a configurable cap (default 5) resolved
through the session-config, environment, and default precedence
chain. Reports have no ids and are not clearable.

#### Scenario: Appending beyond the cap drops the oldest

- **WHEN** the session already stores the cap's count of reports
  and the agent records another
- **THEN** the oldest stored report is dropped and the newest is
  kept

#### Scenario: The cap is configurable

- **WHEN** the environment sets the report cap to 2 and the agent
  records three reports
- **THEN** only the two most recent reports remain stored

### Requirement: FR-036 Memo reports section

The memo SHALL render active reports in a bounded "Agent reports"
section, each entry showing its kind and text, and SHALL omit the
section entirely when no reports are stored.

#### Scenario: Reports ride the memo

- **WHEN** the session stores at least one report and the memo is
  built
- **THEN** the memo contains an "Agent reports" section listing
  each stored report's kind and text

#### Scenario: Section absent when empty

- **WHEN** the session stores no reports and the memo is built
- **THEN** the memo contains no "Agent reports" section

### Requirement: FR-037 request_audit tool

The middleware SHALL offer a `request_audit` tool to supervised
sessions. The tool SHALL accept a `focus` argument and run the
same audit pipeline used for reasoning steps — narrative
stripping, deterministic invariants, then the side-session peer
audit — on the focus text. Whitespace-only focus, or focus from
which stripping removes all formal content, SHALL yield an
actionable result without invoking the peer audit.

#### Scenario: Passed focus enters the verified trace

- **WHEN** the agent calls `request_audit` with focus text that
  passes the audit pipeline
- **THEN** the result reports the audit passed and the stripped
  focus is appended to the verified trace

#### Scenario: Failed focus returns the critique

- **WHEN** the agent calls `request_audit` with focus text that
  fails the audit pipeline
- **THEN** the result reports the audit failed and carries the
  critique text

#### Scenario: Whitespace-only focus is rejected

- **WHEN** the agent calls `request_audit` with whitespace-only
  focus
- **THEN** the result asks for the claim to check and no audit
  runs

### Requirement: FR-038 On-demand audit delivery

A failed on-demand audit SHALL deliver its critique in the tool
result only. It SHALL NOT steer the session, interrupt it, or
consume the regeneration budget, and the critique SHALL be
recorded in the critique log as delivered.

#### Scenario: Failed on-demand audit does not steer

- **WHEN** an on-demand audit fails
- **THEN** the session is not steered or interrupted, and the
  critique reaches the agent through the tool result

#### Scenario: Failed on-demand audit is recorded

- **WHEN** an on-demand audit fails
- **THEN** the critique log gains an entry marked delivered

### Requirement: FR-039 On-demand audit bound

On-demand audits SHALL be bounded per session by a configurable
count (default 8) resolved through the precedence chain. A call
beyond the bound SHALL yield an actionable result stating the
bound and that the automatic audit loop remains in effect.

#### Scenario: Bound exceeded

- **WHEN** the agent has run the bound's count of on-demand
  audits this session and calls `request_audit` again
- **THEN** the result states the on-demand audit limit was
  reached and no audit runs

#### Scenario: Bound is configurable

- **WHEN** the environment sets the on-demand audit bound to 1
  and the agent calls `request_audit` twice
- **THEN** the second call yields the bound message

### Requirement: FR-040 Side sessions are inert

When `recall`, `report`, or `request_audit` is invoked from a
supervisor side session, the tools SHALL return an inert result
stating the tools are not available in side sessions and SHALL
NOT read or modify session state.

#### Scenario: Recall from a side session

- **WHEN** `recall` is invoked from a supervisor side session
- **THEN** the result states the tools are not available in side
  sessions and no state is read

### Requirement: FR-041 Console tools fail open

The tool bodies SHALL NOT throw: odd payloads and unexpected
argument shapes yield actionable results, and a failing tool call
never disturbs the session.

#### Scenario: Malformed arguments yield a result

- **WHEN** a console tool is invoked with arguments of an
  unexpected shape
- **THEN** the tool returns an actionable result rather than
  throwing

### Requirement: FR-042 Report trust boundary

Self-reported text SHALL be recorded and surfaced only. It SHALL
NOT be passed to the peer audit as criteria or prompt content.

#### Scenario: Reports never enter audit prompts

- **WHEN** the session stores a report and the peer audit runs
- **THEN** the audit prompt contains no part of the stored report
  text

### Requirement: FR-077 Console tools confirm only what they store

When the resolved `maxReminders` cap is 0 or less, `remind_me`
SHALL store nothing, SHALL NOT consume a reminder id, and SHALL
return a result stating that reminders are disabled and naming
the cap. When the resolved `maxReports` cap is 0 or less,
`report` SHALL store nothing and SHALL return a result stating
that reports are disabled and naming the cap. Neither tool
SHALL claim memo delivery for an entry it did not store. Input
validation (empty text, unknown report kind) SHALL still run
first. `buildMemo` SHALL treat any `MemoLimits` field that is
missing or not a finite number as its default value.

#### Scenario: remind_me with reminders disabled

- **GIVEN** `OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS=0`
- **WHEN** the agent calls `remind_me` with non-empty text
- **THEN** the result says reminders are disabled
  (maxReminders is 0)
- **AND** the result does not mention the supervisor memo
- **AND** no reminder is stored and no id is consumed

#### Scenario: report with reports disabled

- **GIVEN** `OPENCODE_SUPERVISOR_MEMO_MAX_REPORTS=0`
- **WHEN** the agent calls `report` with a valid kind and text
- **THEN** the result says reports are disabled
  (maxReports is 0)
- **AND** the result does not claim memo delivery
- **AND** no report is stored

#### Scenario: Older limits objects keep default caps

- **GIVEN** a caller passes `buildMemo` a limits object with
  only `maxSolvedItems` and `maxCritiques`
- **AND** the input holds more reports than the default
  `maxReports`
- **WHEN** the memo is built
- **THEN** the reports section shows only the default number of
  most recent reports

### Requirement: FR-078 request_audit focus length cap

The `request_audit` focus SHALL be trimmed and truncated to
`MAX_AUDIT_FOCUS` characters, a fixed constant equal to
`MAX_REPORT_TEXT`, before narrative stripping. The auditor
prompt, the verified trace entry, and the tool result SHALL
carry only the bounded text. A result for a truncated focus
SHALL note the truncation and the cap.

#### Scenario: Over-length focus is truncated before the audit

- **GIVEN** a focus longer than `MAX_AUDIT_FOCUS` characters
- **WHEN** the agent calls `request_audit` and the audit passes
- **THEN** the auditor prompt contains at most
  `MAX_AUDIT_FOCUS` characters of the focus
- **AND** the verified trace entry is no longer than
  `MAX_AUDIT_FOCUS` characters
- **AND** the result notes the focus was truncated to
  `MAX_AUDIT_FOCUS` characters

#### Scenario: A focus within the cap is unchanged

- **GIVEN** a focus of at most `MAX_AUDIT_FOCUS` characters
- **WHEN** the agent calls `request_audit`
- **THEN** the result carries no truncation note

