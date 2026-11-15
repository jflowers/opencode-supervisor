# Spec Delta

## Purpose

Verifies tool-call intent before execution: blocks reward-hacking
argument patterns and file paths absent from the verified
reasoning trace, degrading gracefully when no trace exists.

## ADDED Requirements

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
