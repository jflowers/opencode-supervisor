# Spec Delta

## Purpose

Defines the agent console's reminder surface: two tools the primary
agent can call, the session-state store behind them, memo rendering,
capacity bounds, side-session behavior, and text hygiene — the first
self-serve capability on the supervisor's shared session-state layer.

## ADDED Requirements

### Requirement: FR-020 remind_me tool

The middleware SHALL offer a `remind_me` tool to supervised sessions.
The tool SHALL accept a `text` argument, store a reminder (id, text,
timestamp) in the session state, and return a result reporting the
assigned id and the stored text.

#### Scenario: Agent registers a reminder

- **GIVEN** a supervised session with the plugin active
- **WHEN** the agent calls `remind_me` with text
- **THEN** a reminder is stored for that session and the result
  reports its id and the stored text

#### Scenario: Reminder becomes durable

- **GIVEN** a reminder stored via `remind_me`
- **WHEN** later turns build the supervisor memo
- **THEN** the reminder is rendered in the memo per FR-022

### Requirement: FR-021 forget_reminder tool

The middleware SHALL offer a `forget_reminder` tool that accepts an
`id` argument and removes the matching reminder from the session
state. When no reminder matches, the result SHALL list the ids of the
current reminders and SHALL change nothing.

#### Scenario: Agent removes a reminder by id

- **GIVEN** at least one stored reminder in a session
- **WHEN** the agent calls `forget_reminder` with that reminder's id
- **THEN** the reminder is removed and the result confirms removal

#### Scenario: Unknown id is actionable

- **GIVEN** one or more stored reminders in a session
- **WHEN** the agent calls `forget_reminder` with an id that matches
  no stored reminder
- **THEN** the result lists the current reminder ids and no state
  changes

### Requirement: FR-022 Reminders render in the memo

When a session has one or more stored reminders, the memo SHALL
include a `Reminders:` section listing each reminder as `- <id>:
<text>`, most recent last, bounded by the `maxReminders` limit. When
there are no reminders, the memo SHALL NOT include the section.

#### Scenario: Reminders section appears

- **GIVEN** one or more stored reminders in a session
- **WHEN** the memo is built for that session
- **THEN** a `Reminders:` section lists `- <id>: <text>` entries

#### Scenario: No reminders, no section

- **GIVEN** a session with no stored reminders
- **WHEN** the memo is built for that session
- **THEN** no `Reminders:` section appears

#### Scenario: Rendering is bounded

- **GIVEN** more stored reminders than the `maxReminders` limit
- **WHEN** the memo is built for that session
- **THEN** only the most recent `maxReminders` reminders appear

### Requirement: FR-023 Reminder capacity and configuration

Reminder storage SHALL be bounded to the most recent `maxReminders`
entries. `maxReminders` SHALL resolve through the established
precedence chain: session plugin config, then the
`OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS` environment variable, then
the default of 10.

#### Scenario: Storage bound keeps the most recent

- **GIVEN** the `maxReminders` limit is N
- **WHEN** more than N reminders are added to a session
- **THEN** the session keeps the most recent N reminders

#### Scenario: Environment variable is honored

- **GIVEN** the plugin resolves configuration for a session
- **WHEN** `OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS` is set to `3`
- **THEN** the reminder limit for that session is 3

#### Scenario: Default applies

- **GIVEN** the plugin resolves configuration for a session
- **WHEN** neither session config nor environment sets the limit
- **THEN** the reminder limit is 10

### Requirement: FR-024 Side sessions are inert

When `remind_me` or `forget_reminder` is invoked from a supervisor
side session, the tools SHALL return an inert result stating the
tools are not available in side sessions and SHALL NOT create or
modify reminder state.

#### Scenario: Auditor side session gets an inert result

- **GIVEN** a supervisor auditor side session
- **WHEN** it invokes `remind_me` or `forget_reminder`
- **THEN** an inert result is returned and no reminder state is
  created or changed

### Requirement: FR-025 Reminder text hygiene

`remind_me` SHALL reject whitespace-only text with an actionable
message and store nothing. Stored text SHALL be truncated at a fixed
2000-character ceiling, and the result SHALL note when truncation
occurred.

#### Scenario: Whitespace-only text is rejected

- **GIVEN** a supervised session with the plugin active
- **WHEN** the agent calls `remind_me` with whitespace-only text
- **THEN** no reminder is stored and the result asks for usable text

#### Scenario: Overlong text is truncated

- **GIVEN** a supervised session with the plugin active
- **WHEN** the agent calls `remind_me` with text longer than 2000
  characters
- **THEN** the stored reminder holds the first 2000 characters and
  the result notes the truncation
