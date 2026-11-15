# Spec Delta

## Purpose

Grant one task — a slash command, an agent, or both — a narrow
exemption from the file-path trace check (#47), carried into the
subagent sessions it starts, and stop committed project config
from disabling or unregistering the guards (#48), without
weakening any check for any other session.

## ADDED Requirements

### Requirement: FR-072 Session context tracking

The supervisor SHALL record, per session: the `agent` of the
latest user message seen by `chat.message`; the latest slash
command seen by `command.execute.before`, without a leading
`/`, kept for that command's task — until the first
human-typed (non-synthetic) user message after the session
goes idle that is not itself a slash command; and the
session's `parentID` from `session.created` /
`session.updated` events, falling back to a session lookup
when unknown, whose result is cached and whose failure is
retried after a backoff.
Auditor side sessions SHALL NOT be recorded.

#### Scenario: Latest user message wins

- **GIVEN** a session whose first user message ran `build`
- **WHEN** a later user message runs `curator`
- **THEN** the session's recorded agent is `curator`

#### Scenario: The command persists for the task

- **GIVEN** a session that ran `/dewey-distill`
- **WHEN** a later plain user message arrives
- **THEN** the session's recorded command is still
  `dewey-distill`

### Requirement: FR-073 Profiles from the global file only

`profiles` SHALL be honored only from the global config file.
When present in the project config file or plugin options it
SHALL be ignored with a warning. Each profile SHALL hold a
`match` with `agent` and/or `command` (exact strings; a
leading `/` on `command` ignored) and a `traceCheck` grant,
plus an optional `name`. An invalid profile (non-object,
unknown key, missing or invalid `match`, missing or invalid
grant) SHALL be dropped with a warning naming it, without
rejecting other profiles or other keys of the file.

#### Scenario: Project profiles are ignored

- **GIVEN** a project config file with a profile exempting
  `dewey_*` for agent `curator`
- **WHEN** a `curator` session calls `dewey_store_learning`
  with a path absent from a non-empty verified trace
- **THEN** the trace check applies and a warning reports the
  ignored key

#### Scenario: A bad profile does not drop the lock

- **GIVEN** a global file with `lockGuards: true` and a
  profile with an unknown key
- **WHEN** the plugin loads
- **THEN** the profile is dropped with a warning and
  `lockGuards` stays in force

### Requirement: FR-074 Trace-check exempt tools

A profile's `traceCheck.exemptTools` SHALL be a list of
tool-name globs (`*`, `?`, anchored, case-sensitive). A
profile SHALL apply to a session when every `match` key
equals the context of the session or of one of its ancestors
(up to 8 levels). A call from a session with an applicable
profile whose globs match the tool SHALL skip the file-path
trace check; the reward-hacking check, directive enforcement,
the protected-state check (FR-061), and approve/review gates
SHALL still apply. An entry matching `bash`, `edit`, `write`,
`patch`, `multiedit`, or `apply_patch` SHALL be rejected.

#### Scenario: A granted command passes under any agent

- **GIVEN** a global profile matching command `dewey-distill`
  and exempting `dewey_*`
- **WHEN** an `autonomy` session that ran `/dewey-distill`
  calls `dewey_store_learning` with a path absent from a
  non-empty verified trace
- **THEN** the call is not blocked by the trace check

#### Scenario: Granted agent passes

- **GIVEN** a global profile matching agent `curator` and
  exempting `dewey_*`
- **WHEN** a `curator` session makes the same call
- **THEN** the call is not blocked by the trace check

#### Scenario: Subagents inherit the task's grant

- **GIVEN** the command profile above
- **AND** a child session (agent `general`, no command) whose
  parent ran `/dewey-distill`
- **WHEN** the child makes the same call
- **THEN** the call is not blocked by the trace check

#### Scenario: Other sessions are unchanged

- **GIVEN** the same profiles
- **WHEN** a `build` session with no command, or an
  `autonomy` session that ran `/uf.fix-ci`, makes the same
  call
- **THEN** it is blocked by the trace check

#### Scenario: Both keys must match

- **GIVEN** a profile matching agent `autonomy` and command
  `dewey-distill`
- **WHEN** an `autonomy` session that ran `/uf.fix-ci` makes
  the same call
- **THEN** it is blocked by the trace check

#### Scenario: Reward-hacking still applies

- **GIVEN** the agent profile above
- **WHEN** a `curator` session calls an exempt tool with
  `--no-verify` in a non-content argument
- **THEN** it is blocked by the reward-hacking check

#### Scenario: Protected state still blocks

- **GIVEN** the agent profile above
- **WHEN** a `curator` session calls an exempt tool touching
  `.opencode/supervisor/approvals.json`
- **THEN** it is blocked by the protected-state check

#### Scenario: Catch-alls are rejected

- **GIVEN** a global profile whose `exemptTools` is `["*"]`
- **WHEN** the plugin loads
- **THEN** the profile is dropped with a warning naming the
  matched builtin

#### Scenario: Wildcards must name one MCP server

- **GIVEN** a global profile whose `exemptTools` is
  `["*_file"]`
- **WHEN** the plugin loads
- **THEN** the profile is dropped with a warning that the
  glob must start with an MCP server prefix

#### Scenario: A command's grant ends with its task

- **GIVEN** the command profile above and an `autonomy`
  session that ran `/dewey-distill`
- **WHEN** the session goes idle and a human-typed message
  that is not a slash command arrives
- **THEN** a later exempt-tool call is subject to the trace
  check again

### Requirement: FR-075 Guard lock

When the global config file sets `lockGuards: true`, a
`false` value for `blockRewardHacking` or
`requireStepReferenceInTools` from the project config file or
plugin options SHALL be ignored with a warning. A `mode:
"repair-only"` from the project config file or plugin options
SHALL likewise be ignored with a warning, so a committed
project config cannot unregister the guards. The same
guard-disabling values from environment variables SHALL be
ignored with a warning, since per-directory env tools can set
them from committed files. When `XDG_CONFIG_HOME` points the
global file away from the home-directory file and the
home-directory file sets `lockGuards: true`, the
home-directory file SHALL be the global tier. A global file
rejected for any other reason SHALL still apply
`lockGuards: true` when it sets it. Global-file values SHALL
still apply. `lockGuards` from any tier other than the global
file SHALL be ignored with a warning.

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

#### Scenario: The environment cannot disable a locked guard

- **GIVEN** a global file with `lockGuards: true`
- **AND** `OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS=false`
- **WHEN** a tool call names a path absent from a non-empty
  verified trace
- **THEN** it is blocked by the trace check and a warning
  reports the ignored variable

#### Scenario: The lock survives a rejected global file

- **GIVEN** a global file with `lockGuards: true` and a
  wrong-typed `maxRegenerations`
- **AND** a project file with `requireStepReferenceInTools:
  false`
- **WHEN** the same call is made
- **THEN** it is blocked by the trace check

#### Scenario: Project cannot unregister the guards

- **GIVEN** a global file with `lockGuards: true`
- **AND** a project file with `mode: "repair-only"`
- **WHEN** the plugin loads
- **THEN** the guards stay registered and a warning reports the
  ignored mode
