# Spec Delta

## Purpose

Grant one agent a narrow exemption from the file-path trace check
(#47) and stop committed project config from disabling or
unregistering the guards (#48), without weakening any check for
any other agent.

## ADDED Requirements

### Requirement: FR-072 Session agent tracking

The supervisor SHALL record a session's agent from the
`agent` field of each `chat.message` hook input for a user
message; a later user message SHALL replace the recorded
agent. Auditor side sessions SHALL NOT be recorded.

#### Scenario: Latest user message wins

- **GIVEN** a session whose first user message ran `build`
- **WHEN** a later user message runs `curator`
- **THEN** the session's recorded agent is `curator`

### Requirement: FR-073 Agent overrides from the global file only

`agentOverrides` SHALL be honored only from the global config
file. When present in the project config file or plugin
options it SHALL be ignored with a warning. An invalid entry
(non-object, unknown key, invalid value) SHALL be dropped
with a warning naming the agent, without rejecting other
entries or other keys of the file. Agent names SHALL match
exactly.

#### Scenario: Project overrides are ignored

- **GIVEN** a project config file with `agentOverrides`
  exempting `dewey_*` for `curator`
- **WHEN** a `curator` session calls `dewey_store_learning`
  with a path absent from a non-empty verified trace
- **THEN** the trace check applies and a warning reports the
  ignored key

#### Scenario: A bad entry does not drop the lock

- **GIVEN** a global file with `lockGuards: true` and an
  `agentOverrides` entry with an unknown key
- **WHEN** the plugin loads
- **THEN** the entry is dropped with a warning and
  `lockGuards` stays in force

### Requirement: FR-074 Trace-check exempt tools

An override's `traceCheck.exemptTools` SHALL be a list of
tool-name globs (`*`, `?`, anchored, case-sensitive). A call
from a session whose recorded agent has a matching entry
SHALL skip the file-path trace check; the reward-hacking
check, directive enforcement, the protected-state check
(FR-061), and approve/review gates SHALL still apply. An entry matching `bash`, `edit`, `write`,
`patch`, `multiedit`, or `apply_patch` SHALL be rejected.

#### Scenario: Granted agent passes

- **GIVEN** a global override exempting `dewey_*` for
  `curator`
- **WHEN** a `curator` session calls `dewey_store_learning`
  with a path absent from a non-empty verified trace
- **THEN** the call is not blocked by the trace check

#### Scenario: Other agents are unchanged

- **GIVEN** the same override
- **WHEN** a `build` session makes the same call
- **THEN** it is blocked by the trace check

#### Scenario: Reward-hacking still applies

- **GIVEN** the same override
- **WHEN** a `curator` session calls an exempt tool with
  `--no-verify` in a non-content argument
- **THEN** it is blocked by the reward-hacking check

#### Scenario: Protected state still blocks

- **GIVEN** the same override
- **WHEN** a `curator` session calls an exempt tool touching
  `.opencode/supervisor/approvals.json`
- **THEN** it is blocked by the protected-state check

#### Scenario: Catch-alls are rejected

- **GIVEN** a global override whose `exemptTools` is `["*"]`
- **WHEN** the plugin loads
- **THEN** the entry is dropped with a warning naming the
  matched builtin

### Requirement: FR-075 Guard lock

When the global config file sets `lockGuards: true`, a
`false` value for `blockRewardHacking` or
`requireStepReferenceInTools` from the project config file or
plugin options SHALL be ignored with a warning. A `mode:
"repair-only"` from the project config file or plugin options
SHALL likewise be ignored with a warning, so a committed
project config cannot unregister the guards. Environment
and global-file values SHALL still apply. `lockGuards` from
any tier other than the global file SHALL be ignored with a
warning.

#### Scenario: Project cannot disable a locked guard

- **GIVEN** a global file with `lockGuards: true`
- **AND** a project file with `requireStepReferenceInTools:
  false`
- **WHEN** a tool call names a path absent from a non-empty
  verified trace
- **THEN** it is blocked by the trace check

#### Scenario: Without the lock, project config still wins

- **GIVEN** no `lockGuards`
- **AND** a project file with `requireStepReferenceInTools:
  false`
- **WHEN** the same call is made
- **THEN** it is not blocked by the trace check

#### Scenario: Project cannot unregister the guards

- **GIVEN** a global file with `lockGuards: true`
- **AND** a project file with `mode: "repair-only"`
- **WHEN** the plugin loads
- **THEN** the guards stay registered and a warning reports the
  ignored mode
