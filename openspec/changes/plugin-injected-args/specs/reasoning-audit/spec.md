# reasoning-audit

## ADDED Requirements

### Requirement: FR-106 plugin-injected tool arguments reach the auditor

When a known producer plugin publishes injected-args records on its
process-wide shared state (`injectedArgs`, a `Map` from callID to
`{ sessionID, tool, args }`), every peer audit of a session (reasoning
parts and `request_audit`) MUST include the session's most recent
records (at most 12) under a plugin-injected-arguments note telling
the auditor the agent did not write those values and must not be
asked to remove them, re-run the call, or retract a result because of
them. With no records the audit prompt MUST be unchanged. Reading the
records MUST NOT throw: a missing or malformed state reads as none.

#### Scenario: harness-injected topic tag

- **GIVEN** the harness recorded `tags: ["topic:wirecheck"]` for a
  `note_save` call in session S
- **WHEN** a reasoning part of S is audited
- **THEN** the prompt lists that call and value under the note

#### Scenario: other sessions and no producer

- **WHEN** records exist only for other sessions, or no producer is
  loaded
- **THEN** the audit prompt has no plugin-injected section
