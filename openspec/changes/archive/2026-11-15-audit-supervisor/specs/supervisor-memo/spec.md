# Spec Delta

## Purpose

Maintains and injects a supervision context — session goal,
solved-items log, and prior critiques — into the system prompt so
the agent stays oriented toward the goal and avoids redoing work.

## ADDED Requirements

### Requirement: FR-013 Session goal capture
The system SHALL record the first user message of a session as
that session's goal.

#### Scenario: Goal captured from first message
- **WHEN** a session receives its first user message
- **THEN** that message is retained as the session goal

#### Scenario: Later messages do not replace the goal
- **WHEN** a session with a recorded goal receives another user
  message
- **THEN** the goal remains the first message

### Requirement: FR-014 Solved-items log
The system SHALL append an entry to the session's solved-items log
when a tool call completes, recording the tool and a short outcome
summary. The log SHALL be bounded to the most recent entries.

#### Scenario: Completed tool call is logged
- **WHEN** a tool call completes successfully
- **THEN** the solved-items log gains an entry naming the tool
  and its outcome

#### Scenario: Log stays bounded
- **WHEN** more tool calls complete than the log bound allows
- **THEN** the oldest entries are dropped

### Requirement: FR-015 Prior critiques log
The system SHALL record each audit critique delivered or withheld
in the session, so the agent sees prior findings in context.

#### Scenario: Critique appears in the log
- **WHEN** an audit fails and a critique is produced
- **THEN** the critique is recorded for the supervision context

### Requirement: FR-016 Memo injection before each model call
Before each model call in a supervised session, the system SHALL
append a supervision memo to the conversation as one trailing
user message — via the `experimental.chat.messages.transform`
hook, whose payload mutations reach the model request on
OpenCode 1.19.0 — containing the session goal, the solved-items
log, and prior critiques, each section present only when it has
content. The memo message is transform-time only: it is never
persisted to the session and is rebuilt fresh on each user
prompt. (Amendment 2026-10-27: delivery moved off
`experimental.chat.system.transform`, whose payload mutations
the OpenCode 1.19.0 build discards before building the
request.)

#### Scenario: Memo carries goal and solved items
- **WHEN** a model call occurs in a session with a recorded goal
  and two solved items
- **THEN** the conversation gains one trailing memo message
  listing the goal and both items

#### Scenario: Empty sections are omitted
- **WHEN** a session has a goal but no solved items or critiques
- **THEN** the memo contains only the goal section

#### Scenario: Sessions without a memo are untouched
- **WHEN** a session has no goal, solved items, or critiques
- **THEN** the conversation payload is unchanged

### Requirement: FR-017 Memo is bounded
The memo SHALL have bounded size: solved items and critiques are
capped at configurable maximum counts so the system prompt cannot
grow without limit across a long session.

#### Scenario: Long session keeps memo stable
- **WHEN** a session exceeds the solved-items cap
- **THEN** the memo length stays within its bound
