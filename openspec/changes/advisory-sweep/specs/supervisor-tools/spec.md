# Spec Delta

## ADDED Requirements

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
