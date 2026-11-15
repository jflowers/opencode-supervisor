# Spec Delta

## ADDED Requirements

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
