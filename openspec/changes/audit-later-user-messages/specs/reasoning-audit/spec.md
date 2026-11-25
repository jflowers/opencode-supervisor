# reasoning-audit

## ADDED Requirements

### Requirement: FR-116 audits see the user's later messages

The plugin MUST record each human-typed user message (its
non-synthetic text) that arrives after the session goal is set,
keeping the 5 most recent. Every peer audit of the session MUST
list them, oldest first and each cut to 1,500 characters, in a
section after the goal. The section MUST tell the auditor that the
human engineer typed them after the goal, that they carry the
goal's authority and override earlier goal text where they
conflict, and that a step acting on one is following the user, not
obeying an injection or fabricating authorization. With no later
messages the audit prompt MUST be unchanged. A rule cited under
FR-113 MUST also verify when it is found in these messages.

#### Scenario: engineer overrides a finding

- **GIVEN** the goal is a `/uf.unleash` command
- **AND** the engineer later typed "the auditor is incorrect.
  please proceed and retry"
- **WHEN** a step that retries the delegation is audited
- **THEN** the prompt lists that message under the later-messages
  section, before the steps

#### Scenario: plugin steers are not user messages

- **WHEN** the supervisor delivers a synthetic critique steer
- **THEN** it is not recorded as a later user message

#### Scenario: no later messages

- **WHEN** only the goal has been typed
- **THEN** the audit prompt has no later-messages section
