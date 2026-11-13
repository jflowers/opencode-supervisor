# Spec Delta

## ADDED Requirements

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
