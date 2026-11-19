# reasoning-audit

## ADDED Requirements

### Requirement: FR-105 side-session registry is a cross-plugin contract

The record at
`globalThis[Symbol.for('opencode-agent-supervisor.shared-state')]`
MUST carry `sideSessionIds`, a `Set<string>` of live supervisor side
session ids, and the README MUST document it for other plugins. A
side session's id MUST be in the set before the side session is
prompted and MUST be removed when it is deleted. On a
`session.created` event for a side session, the supervisor's `event`
hook MUST register the id before it yields, so plugins whose `event`
hook is dispatched after the supervisor's see it.

#### Scenario: read without importing the package

- **WHEN** another plugin reads the record under the global symbol
- **THEN** `sideSessionIds` is the supervisor's live registry

#### Scenario: first events of a side session

- **GIVEN** the supervisor's `event` hook is dispatched before
  another plugin's
- **WHEN** an audit or repair side session is created and prompted
- **THEN** the other plugin finds the id in the registry on
  `session.created` and on the first message event

#### Scenario: side session deleted

- **WHEN** the side session is cleaned up
- **THEN** its id is no longer in the registry
