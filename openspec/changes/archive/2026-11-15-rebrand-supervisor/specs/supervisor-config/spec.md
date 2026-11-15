# Spec Delta

## Purpose

Defines the plugin's identity and configuration surface so the
rename from `opencode-reasoning-audit` to `opencode-supervisor` is
a spec'd contract, not just a string change, and future config
additions (reminders, directives) have a home.

## ADDED Requirements

### Requirement: FR-018 Plugin identity

The middleware SHALL identify itself as `opencode-supervisor` in
its plugin id, session config key, and package name, and SHALL
carry version 2.0.0. User-visible plugin output SHALL be prefixed
`[supervisor]`.

#### Scenario: Plugin registers under the new id

- **GIVEN** the plugin is installed and loadable by OpenCode
- **WHEN** OpenCode loads the plugin
- **THEN** it registers as `opencode-supervisor` at version 2.0.0

#### Scenario: Critique messages carry the new prefix

- **GIVEN** a reasoning step fails its peer audit
- **WHEN** the failed audit delivers a critique to the session
- **THEN** the steering message is prefixed `[supervisor]`

### Requirement: FR-019 Supervisor configuration surface

All environment-variable configuration SHALL use the
`OPENCODE_SUPERVISOR_` prefix: MODEL, VARIANT, MAX_REGENERATIONS,
STRIP_MODE, BLOCK_REWARD_HACKING, REQUIRE_STEP_REFERENCE_IN_TOOLS,
MEMO_MAX_SOLVED_ITEMS, MEMO_MAX_CRITIQUES. Variables using the 1.x
`OPENCODE_AUDITOR_` prefix SHALL NOT be read; no aliases are
supported. Config precedence is otherwise unchanged (session
plugin config, then environment, then defaults).

#### Scenario: Renamed variable is honored

- **GIVEN** the plugin resolves configuration for a session
- **WHEN** `OPENCODE_SUPERVISOR_MAX_REGENERATIONS` is set to `4`
- **THEN** the critique bound for that session is 4

#### Scenario: Legacy variable is ignored

- **GIVEN** the plugin resolves configuration for a session
- **WHEN** only `OPENCODE_AUDITOR_MAX_REGENERATIONS` is set
- **THEN** the default bound applies as if no variable were set
