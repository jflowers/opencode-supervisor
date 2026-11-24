# reasoning-audit

## ADDED Requirements

### Requirement: FR-111 audits see the session's completed tool calls

Every peer audit of a session (reasoning parts and `request_audit`)
MUST include the session's completed tool calls recorded before the
audit started (tool name and short outcome, oldest first, the most
recent 40 at most) under a session-progress note. The note MUST tell
the auditor that the calls are context and not steps to audit, that
step numbers count only the audited steps, that a prerequisite
listed there has already happened, and that a prerequisite must not
be assumed missing because the audited steps do not mention it.
When older calls may have been cut, the section MUST say so. With
no completed calls the audit prompt MUST be unchanged.

#### Scenario: prerequisite succeeded several calls earlier

- **GIVEN** the goal says "Do not edit any code before debug_open
  succeeds"
- **AND** `debug_open`, `debug_hypothesize`, and
  `debug_experiment_start` completed in the session
- **WHEN** a reasoning part that edits `src/duration.ts` is audited
- **THEN** the prompt lists those calls under the note, before the
  steps, with `debug_open` first among them

#### Scenario: no completed calls

- **WHEN** a session's first reasoning part is audited before any
  tool call completed
- **THEN** the audit prompt has no session-progress section
