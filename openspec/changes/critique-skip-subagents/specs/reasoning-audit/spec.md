# reasoning-audit

## ADDED Requirements

### Requirement: FR-111 no critique steering in subagents

Critique delivery MUST NOT abort or steer a session that has a
parent session. The critique MUST be recorded as withheld
(FR-015) and the skip MUST be logged. It MUST NOT count against
`maxRegenerations`.

#### Scenario: severe finding in a subagent

- **GIVEN** a session whose `session.created` event names a parent
- **WHEN** an audit of its reasoning fails with severity severe
- **THEN** the session is not aborted
- **AND** no steering prompt is sent
- **AND** the critique is recorded with `delivered: false`

#### Scenario: root session unchanged

- **GIVEN** a session with no parent
- **WHEN** an audit fails
- **THEN** the critique is delivered as FR-007 and FR-008 say

### Requirement: FR-112 steers keep the session's agent and model

Every steering prompt sent with `promptAsync` MUST name the agent
and model of the session's latest user message when they are
known. When they are not known from `chat.message`, the plugin
MUST look them up from the session's messages; when the lookup
fails, the steer MUST still be sent.

#### Scenario: critique to a non-default agent

- **GIVEN** a session whose latest user message used agent
  `reviewer` and model `acme/model-x`
- **WHEN** a critique is delivered
- **THEN** the steer names agent `reviewer` and model
  `acme/model-x`

#### Scenario: text tool-call correction

- **GIVEN** a root session whose latest user message named an
  agent and model
- **WHEN** a text tool-call correction is sent
- **THEN** the correction names that agent and model
