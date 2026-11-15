# supervisor-config Specification

## Purpose
The plugin's identity, configuration files, precedence tiers,
global-only guard profiles and guard lock, and legacy
environment-variable warnings.
## Requirements
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

### Requirement: FR-076 Legacy environment variables warn at load

At plugin load the supervisor SHALL scan the process environment
for variable names beginning with `OPENCODE_AUDITOR_` whose value
is non-empty. When any is found, it SHALL log exactly one warning
through the plugin logger that names each such variable and its
`OPENCODE_SUPERVISOR_` replacement (or states that
`OPENCODE_AUDITOR_ENDPOINT` was removed) and points at the README
1.x migration section. The warning SHALL NOT include any variable
value. Legacy values SHALL NOT be read as configuration (FR-019
is unchanged). The list SHALL be bounded to 10 names, with the
remainder counted.

#### Scenario: A legacy variable is named with its replacement

- **GIVEN** `OPENCODE_AUDITOR_BLOCK_REWARD_HACKING=false` is set
- **WHEN** the plugin loads and its first hook runs
- **THEN** one warning names
  `OPENCODE_AUDITOR_BLOCK_REWARD_HACKING` and
  `OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING`
- **AND** the warning does not contain the value `false`

#### Scenario: Legacy values are still ignored

- **GIVEN** only `OPENCODE_AUDITOR_MAX_REGENERATIONS=4` is set
- **WHEN** the plugin resolves configuration for a session
- **THEN** the default critique bound applies

#### Scenario: No legacy variables, no warning

- **GIVEN** no `OPENCODE_AUDITOR_` variable is set
- **WHEN** the plugin loads
- **THEN** no legacy-variable warning is logged

#### Scenario: The removed endpoint variable is named as removed

- **GIVEN** `OPENCODE_AUDITOR_ENDPOINT` is set
- **WHEN** the plugin loads
- **THEN** the warning says the variable was removed and has no
  replacement

