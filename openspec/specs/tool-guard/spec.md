# tool-guard Specification

## Purpose
Verifying tool calls before they run: reward-hacking blocks,
the file-path trace check, and directive enforcement.
## Requirements
### Requirement: FR-009 Tool verification before execution
The system SHALL inspect every tool call's arguments before the
tool executes and SHALL block execution when the arguments contain
a reward-hacking pattern (`--no-verify`, a skipped-test marker, a
tautological assertion, or a test-directory deletion).

#### Scenario: Reward-hacking arguments blocked
- **WHEN** a tool call's arguments contain `--no-verify` or
  `rm -rf tests`
- **THEN** the tool does not execute and the agent receives the
  block reason

#### Scenario: Benign arguments pass
- **WHEN** a tool call's arguments contain none of the blocked
  patterns
- **THEN** the tool executes normally

### Requirement: FR-010 File paths must appear in the trace
When a verified reasoning trace exists for the session, every file
path in a tool call's arguments SHALL appear in that trace (by
basename or full path), or the system SHALL block the call.

#### Scenario: Unreferenced file path blocked
- **WHEN** the verified trace mentions `src/a.ts` only and a tool
  call targets `src/b.ts`
- **THEN** the call is blocked with a reason referencing the
  missing step

#### Scenario: Referenced file path allowed
- **WHEN** the verified trace mentions `src/a.ts` and a tool call
  targets `src/a.ts`
- **THEN** the call proceeds

### Requirement: FR-011 Graceful degradation without a trace
When no audited reasoning exists for a session yet, the file-path
trace check MUST NOT block tool calls; only the reward-hacking
pattern check remains active.

#### Scenario: First tool call before any reasoning audit
- **WHEN** a session has no verified trace and a tool call
  targets any file path
- **THEN** the call proceeds unless its arguments match a
  reward-hacking pattern

### Requirement: FR-012 Block reason is surfaced
When the system blocks a tool call, it SHALL surface a reason the
agent can act on, identifying the failed check and, for trace
mismatches, the unmatched path.

#### Scenario: Agent can self-correct after a block
- **WHEN** a call is blocked for an unreferenced path
- **THEN** the error the agent sees names the path and states it
  was absent from the verified reasoning trace

### Requirement: FR-071 Reward-hacking scans execution surfaces

The reward-hacking check (FR-009) SHALL scan only argument
values that can act on the workspace. For bash, the full
argument object SHALL be scanned. For the read-only builtin
tools `read`, `glob`, `grep`, `webfetch`, and `websearch`, no
argument SHALL be scanned. For every other tool, every
argument key outside the content keys (`content`, `oldString`,
`newString`) SHALL be scanned; `oldString` SHALL NOT be
scanned; `content` and `newString` SHALL be scanned unless the
call has no file target or every file target is a prose
document (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`,
case-insensitive). The block reason and `blockedCheck` SHALL
be unchanged.

#### Scenario: Prose that quotes a marker is data

- **GIVEN** a `write` call whose `filePath` is
  `kb/topics/git-commit.md`
- **AND** whose `content` says never to commit with
  `--no-verify`
- **WHEN** the call is verified
- **THEN** it is not blocked by the reward-hacking check

#### Scenario: Bash use of a marker still blocks

- **GIVEN** a bash call whose command is
  `git commit -m "x" --no-verify`
- **WHEN** the call is verified
- **THEN** it is blocked by the reward-hacking check

#### Scenario: Skipping a test in a test file still blocks

- **GIVEN** an `edit` call on `test/audit.test.ts` whose
  `newString` adds `it.skip(`
- **WHEN** the call is verified
- **THEN** it is blocked by the reward-hacking check

#### Scenario: Removing a skip is the fix

- **GIVEN** an `edit` call on `test/audit.test.ts` whose
  `oldString` contains `it.skip(` and whose `newString` does
  not
- **WHEN** the call is verified
- **THEN** it is not blocked by the reward-hacking check

#### Scenario: Scripts are not prose

- **GIVEN** a `write` call whose `filePath` is
  `scripts/commit.sh`
- **AND** whose `content` runs `git commit --no-verify`
- **WHEN** the call is verified
- **THEN** it is blocked by the reward-hacking check

#### Scenario: Read-only queries are not scanned

- **GIVEN** a `grep` call whose `pattern` is `\.skip\(`
- **WHEN** the call is verified
- **THEN** it is not blocked by the reward-hacking check

#### Scenario: Custom keys stay covered

- **GIVEN** a custom tool call carrying `--no-verify` under a
  non-content key such as `flags`
- **WHEN** the call is verified
- **THEN** it is blocked by the reward-hacking check

#### Scenario: Target-less content payloads are data

- **GIVEN** a `note_save` call with no file target whose
  `content` quotes `expect(true).toBe(true)`
- **WHEN** the call is verified
- **THEN** it is not blocked by the reward-hacking check

