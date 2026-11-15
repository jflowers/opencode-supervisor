# Spec Delta

## Purpose

Defines the plugin's log sink: every diagnostic the supervisor
emits goes to the OpenCode server log through the SDK client, never
to stdout/stderr, with bounded delivery so a booting server or a
failing audit loop cannot degrade the terminal or flood the log.

## ADDED Requirements

### Requirement: FR-052 server log routing

The middleware SHALL route all diagnostic output (info, warn,
error) through a plugin logger that writes to the OpenCode server
log via the SDK client's `/log` endpoint, tagged with the service
name `opencode-supervisor`. The middleware SHALL NOT write to
stdout, stderr, or the console from any module or hook.

#### Scenario: hook warning reaches the server log

- **GIVEN** a supervised session with the plugin active
- **WHEN** a hook emits a warning
- **THEN** the warning is delivered to the server log with service
  `opencode-supervisor` and level `warn`, and nothing is written to
  stdout or stderr

#### Scenario: levels map to log levels

- **GIVEN** the plugin logger
- **WHEN** info, warn, and error messages are emitted
- **THEN** each is delivered with its corresponding level
  (`info`, `warn`, `error`)

### Requirement: FR-053 fire-and-forget delivery

The plugin logger SHALL deliver entries without awaiting the result
and SHALL absorb delivery failures, including rejection from a
server listener that is not yet listening during plugin bootstrap.
A failed or pending delivery SHALL NOT break hook execution, and
SHALL NOT produce an unhandled rejection.

#### Scenario: logging during bootstrap

- **GIVEN** the plugin server function starting before the
  OpenCode HTTP listener is ready
- **WHEN** the logger delivers an entry and the POST rejects
- **THEN** the rejection is absorbed and plugin startup continues

### Requirement: FR-054 deduplicated warn and error entries

The plugin logger SHALL deduplicate repeated warn and error
entries by identical level and message within the plugin process,
so per-step failure loops (for example, an audit that fails open on
every reasoning step) log once rather than spraying. Info entries
SHALL NOT be deduplicated.

#### Scenario: repeated failure logs once

- **GIVEN** a peer audit that fails open with the same error on
  every reasoning step in a session
- **WHEN** each failure is logged as a warning
- **THEN** only the first delivery reaches the server log

#### Scenario: distinct errors still surface

- **GIVEN** one deduplicated warning already delivered
- **WHEN** a different warning message is emitted
- **THEN** that message is delivered

### Requirement: FR-055 identity line on first hook

The middleware SHALL log its identity and version (with the
resolved auditor model and directive count) at info level exactly
once per plugin process, on the first hook invocation after
startup, so the entry is written when the server listener is
available.

#### Scenario: identity logged once per process

- **GIVEN** a plugin process that has just started
- **WHEN** the first hook fires
- **THEN** one identity line is delivered at info level, and no
  further identity lines are delivered by that process
