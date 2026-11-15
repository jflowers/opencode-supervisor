# Spec Delta

## Purpose

The verified-trace check pipeline end to end: what the verified
reasoning trace contains, which tool-call arguments the trace
check scans, how those arguments are tokenized and matched
against the trace, and when the check reads the trace. Refines
the pending tool-guard (FR-010..FR-012) and reasoning-audit
(FR-001, FR-002, FR-003, FR-006) contracts.

## ADDED Requirements

### Requirement: FR-062 Arithmetic chains evaluate as full expressions

The arithmetic invariant SHALL evaluate each stated equation
as one full expression with standard operator precedence
(multiplication and division before addition and subtraction,
left-associative). A mismatch beyond a small floating-point
tolerance SHALL fail; division by zero SHALL decline to judge.
The critique SHALL quote the full matched expression verbatim.

#### Scenario: Correct chained sums pass

- **GIVEN** a completed reasoning step is under audit
- **WHEN** the step states any of the field chains
  `38+16+2=56`, `1+1+3+2+2+2+9 = 20`, `456+139+62=657`,
  `133+3+521=657`, or `31+3+623=657`
- **THEN** the step passes the arithmetic invariant and no
  critique is delivered

#### Scenario: Standalone errors still fail

- **GIVEN** a completed reasoning step is under audit
- **WHEN** the step states `16 + 2 = 56` or `2 * 3 = 8`
- **THEN** the arithmetic invariant fails the step

#### Scenario: Mixed precedence evaluates correctly

- **GIVEN** a completed reasoning step is under audit
- **WHEN** the step states `2+3*4=14`
- **THEN** the step passes, because 3*4 binds before the
  addition
- **WHEN** the step states `2+3*4=20`
- **THEN** the step fails, because the expression evaluates
  to 14

#### Scenario: The critique quotes the whole expression

- **GIVEN** a reasoning step states an incorrect chained sum
- **WHEN** the arithmetic invariant fails the step
- **THEN** the critique quotes the complete stated expression
  verbatim, so a flagged claim is self-describing rather than
  a misread fragment

### Requirement: FR-063 Minor deterministic failures keep trace content

When a deterministic invariant fails with minor severity (an
arithmetic misstatement or an off-by-one bound), the system
SHALL deliver the bounded critique and SHALL still record the
step in the verified trace, as an entry carrying its outcome.
The directive-gates review gate SHALL release only on passed
steps, and `request_audit` recording SHALL stay passed-only
(FR-037). Severe deterministic findings (reward hacking) and
peer-audit failures SHALL still evict the whole step from
the trace.

#### Scenario: A misstated tally no longer vanishes path mentions

- **GIVEN** a reasoning step that mentions `kb/topics/gov-ci.md`
  and also states the mis-sum `38+16+2=57`
- **WHEN** the step is audited
- **THEN** the arithmetic critique is delivered and the step,
  including its path mention, remains in the verified trace

#### Scenario: An off-by-one bound critiques without eviction

- **GIVEN** a reasoning step that names a file and contains
  `i <= items.length`
- **WHEN** the step is audited
- **THEN** the off-by-one critique is delivered and the step
  remains in the verified trace

#### Scenario: Severe findings still evict

- **GIVEN** a reasoning step that contains a reward-hacking
  marker
- **WHEN** the step is audited
- **THEN** the step is evicted from the verified trace and the
  interrupt path applies

#### Scenario: Peer-audit failures still evict

- **GIVEN** a reasoning step that passes the deterministic
  invariants
- **WHEN** the peer-audit model returns a failed verdict for
  the step
- **THEN** the step stays out of the verified trace

#### Scenario: A minor-failed step never releases a review gate

- **GIVEN** a review gate holds a path and the verified trace
  holds a minor-failed entry referencing it, with no passed
  entry referencing it
- **WHEN** a tool call touches that gated path
- **THEN** the call is blocked: the review gate counts only
  passed steps

#### Scenario: A failed on-demand focus does not append

- **GIVEN** the agent calls `request_audit` and the focus
  fails a minor deterministic invariant
- **WHEN** the audit completes
- **THEN** the critique is returned in the tool result and the
  focus is not appended to the verified trace

### Requirement: FR-064 The trace check scans operational arguments

The trace check SHALL scan operational argument values only.
For tools other than bash, top-level string values under the
content keys (`content`, `oldString`, `newString`) are authored
data and SHALL NOT be scanned; every other argument key SHALL
be scanned, so unknown and custom key names stay covered. Bash
command strings SHALL remain operational in full.

#### Scenario: Authored content quoting a filename is data

- **GIVEN** a non-empty verified trace and a `write` call whose
  `filePath` is trace-referenced but whose `content` quotes
  `risk-tier1.sh`, absent from the trace
- **WHEN** the call is verified
- **THEN** it is not blocked by the trace check

#### Scenario: Custom argument keys stay covered

- **GIVEN** a non-empty verified trace and a custom tool call
  carrying an unreferenced path under a non-content key such as
  `target`
- **WHEN** the call is verified
- **THEN** it is blocked by the trace check

#### Scenario: Bash command text stays operational

- **GIVEN** a non-empty verified trace and a bash call whose
  command string names an unreferenced path
- **WHEN** the call is verified
- **THEN** it is blocked by the trace check

#### Scenario: The operational positive case is intact

- **GIVEN** a non-empty verified trace and a call whose
  operational `filePath` is absent from the trace
- **WHEN** the call is verified
- **THEN** it is blocked by the trace check (FR-010)

### Requirement: FR-065 Console tools are exempt from the trace check

Tool calls to the plugin's own registered agent-console tools
SHALL be exempt from the file-path trace check. The exemption
SHALL be derived from the registered tool map so a future
console tool is covered automatically. The reward-hacking
check SHALL still apply to console tools.

#### Scenario: request_audit focus names a blocked basename

- **GIVEN** a non-empty verified trace and a `request_audit`
  call whose `focus` names a path absent from the trace
- **WHEN** the call is verified
- **THEN** it is not blocked by the trace check, and the audit
  channel stays open

#### Scenario: A future console tool is exempt automatically

- **GIVEN** the exemption is derived from the registered tool
  map
- **WHEN** a new tool is added to the plugin's registered tool
  map
- **THEN** calls to it are exempt from the trace check without
  further guard changes

### Requirement: FR-066 Path tokens match with pattern semantics

The trace check's tokenizer SHALL recognize wildcard- and
variable-bearing path tokens: an operational token containing
glob metacharacters or shell variables is a pattern whose
runtime expansion is unknown. A pattern token SHALL pass when
the trace references a satisfying path or the pattern itself;
otherwise the call SHALL block naming the pattern. Extension
matching SHALL carry a trailing boundary, and block reasons
SHALL name only tokens that exist.

#### Scenario: A wildcard satisfied by a trace reference passes

- **GIVEN** the verified trace references
  `kb/topics/gov-ci.md`
- **WHEN** a call's operational argument is
  `kb/topics/*.md`
- **THEN** the call is not blocked by the trace check

#### Scenario: An unsatisfied wildcard blocks by naming the pattern

- **GIVEN** a non-empty verified trace with no path matching
  the pattern
- **WHEN** a call's operational argument is `kb/topics/*.md`
- **THEN** the call is blocked and the reason names the
  pattern, directing the agent to reason about the files it
  expands to or name them concretely

#### Scenario: Shell variables create no phantom demand

- **GIVEN** the trace check tokenizes a call's operational
  arguments
- **WHEN** a bash argument contains `"$bdir/$id.md"`
- **THEN** the check never demands `id.md` from the trace; the
  token is matched as a pattern

#### Scenario: A pattern mention satisfies itself

- **GIVEN** a passed reasoning step references the pattern
  `$bdir/$id.md` verbatim
- **WHEN** a call uses that same spelling
- **THEN** the call is not blocked by the trace check

#### Scenario: Extension matching carries a trailing boundary

- **GIVEN** the trace check tokenizes a call's operational
  arguments
- **WHEN** a tool argument contains `config.json`
- **THEN** the tokenizer produces `config.json` and not the
  prefix `config.js`

#### Scenario: The empty-trace allow is unchanged

- **GIVEN** no verified trace exists for the session
- **WHEN** a call carries a wildcard or `$var`-bearing token
- **THEN** the call is not blocked by the trace check
  (FR-011)

### Requirement: FR-067 Bounded wait for in-flight audits

When a tool call would block on the trace check while audits
of the session's reasoning are still in flight, the guard
SHALL wait, bounded by a fixed timeout, then re-evaluate the
check against the settled trace. A rejected continuation
SHALL count as settled, logged once and never thrown into
the hook. On timeout the call SHALL be allowed and the delay
logged (fail-open, FR-005), up to a per-session bound; past
that bound a timed-out wait SHALL block naming the
still-unsettled audit. Every timeout SHALL be logged. A path
genuinely absent from settled, verified reasoning SHALL
still block.

#### Scenario: Same-turn reasoning arrives before the verdict

- **GIVEN** the trace already holds earlier verified steps, a
  reasoning part naming path P is still being audited, and the
  audit resolves within the bound
- **WHEN** a tool call with operational argument P arrives
  before the audit completes
- **THEN** the guard waits for the audit and allows the call
  once the step is recorded, with no block on the first
  attempt

#### Scenario: Timeout fails open

- **GIVEN** an audit that does not settle within the bound and
  the session is below its timeout fail-open bound
- **WHEN** a call would block on the trace check
- **THEN** the call is allowed and one warning naming the
  delay is logged

#### Scenario: Teeth are preserved on settled traces

- **GIVEN** no audits are in flight and the settled trace does
  not reference path P
- **WHEN** a call targets P operationally
- **THEN** the call is blocked

#### Scenario: The empty-trace allow is unchanged

- **GIVEN** no reasoning exists for the session at all
- **WHEN** a tool call arrives
- **THEN** the empty-trace allow applies (FR-011) and the
  guard imposes no wait

#### Scenario: A rejected continuation settles the wait

- **GIVEN** an in-flight audit continuation rejects while a
  call is waiting on the trace check
- **WHEN** the rejection lands
- **THEN** the wait settles, the rejection is logged once, and
  the guard re-evaluates against the live trace without
  throwing into the hook

#### Scenario: Repeated timeouts stop failing open

- **GIVEN** the session has already failed open on timeouts up
  to its per-session bound
- **WHEN** another wait times out with the audit still
  unsettled
- **THEN** the call is blocked with a reason naming the
  still-unsettled audit, and the timeout is logged

### Requirement: FR-068 Path-bearing steps survive narrative stripping

In `code_and_math` and `balanced` strip modes, a reasoning step
carrying a path-like token SHALL survive narrative stripping
(narrative-prefix removal still applies), so its path mentions
reach the audit and the verified trace. The `strict` mode SHALL
remain unchanged: only fenced code and explicit equations
survive.

#### Scenario: Prose path mentions survive the default mode

- **GIVEN** the strip mode is `code_and_math`
- **WHEN** a step is plain prose mentioning `notes.md` with no
  code ticks or operators
- **THEN** the step survives stripping and is audited

#### Scenario: Balanced mode keeps the same survival

- **GIVEN** the strip mode is `balanced`
- **WHEN** the same prose step mentioning `notes.md` is
  processed
- **THEN** the step survives stripping and is audited

#### Scenario: Strict mode is unchanged

- **GIVEN** the strip mode is `strict`
- **WHEN** the same prose step mentioning `notes.md` is
  processed
- **THEN** the step is dropped, as before

#### Scenario: The corrective instruction becomes followable

- **GIVEN** a block reason instructing the agent to reason
  about a file in verified steps and then retry
- **WHEN** the model re-states its plan in plain prose naming
  that file and the step passes audit
- **THEN** the retried call is not blocked by the trace check
