# reasoning-audit

## ADDED Requirements

### Requirement: FR-099 side sessions are never supervised

Every copy of the plugin in one process MUST treat a supervisor
side session as its own machinery and skip it in every hook,
whichever copy created it. A session whose title starts with
`supervisor-audit @` or `supervisor-repair @` MUST be treated as
a side session once its `session.created` or `session.updated`
event is seen.

#### Scenario: two copies of the plugin

- **GIVEN** two copies of the plugin loaded for one directory
- **WHEN** copy A's auditor side session emits a completed
  reasoning part
- **THEN** copy B does not audit it

#### Scenario: side session from another version

- **GIVEN** a `session.created` event whose title starts with
  `supervisor-audit @`
- **WHEN** that session emits a completed reasoning part
- **THEN** no audit runs

### Requirement: FR-100 side sessions have no tools

Auditor and repair side sessions MUST be prompted with every tool
disabled (`tools: { '*': false }`).

#### Scenario: auditor prompt body

- **WHEN** an audit prompts its side session
- **THEN** the prompt body disables all tools

### Requirement: FR-101 auditor timeout

The auditor prompt MUST be bounded by a timeout. On timeout the
side session MUST be aborted and deleted, best effort, and the
audit MUST fail open (FR-005).

#### Scenario: stuck auditor

- **GIVEN** an auditor prompt that never resolves
- **WHEN** the timeout elapses
- **THEN** the side session is aborted and deleted
- **AND** the step passes with the timeout recorded as an error

### Requirement: FR-102 concurrent audit cap

At most `MAX_CONCURRENT_AUDITS` auditor side sessions MUST be in
flight per process. An audit over the cap MUST fail open without
creating a side session.

#### Scenario: cap reached

- **GIVEN** the cap number of audits in flight
- **WHEN** another audit starts
- **THEN** no side session is created and the audit fails open

### Requirement: FR-103 duplicate load warning

When a second, distinct copy of the plugin starts for a directory
that another copy already supervises, the plugin MUST log one
warning naming the duplicate load.

#### Scenario: npm and path copies

- **GIVEN** a copy loaded from one module URL for a directory
- **WHEN** a copy from a different module URL starts for it
- **THEN** one warning is logged
