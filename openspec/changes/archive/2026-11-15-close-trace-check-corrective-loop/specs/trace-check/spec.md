# Spec Delta

## MODIFIED Requirements

### Requirement: FR-067 Bounded wait for in-flight audits

When a tool call would block on the trace check while audits
of the session's reasoning are still in flight, the guard
SHALL wait, bounded by a fixed timeout, then re-evaluate the
check against the settled trace. A rejected continuation
SHALL count as settled, logged once and never thrown into
the hook. On timeout the call SHALL be allowed and the delay
logged (fail-open, FR-005), up to a per-session bound; past
that bound a timed-out wait SHALL block naming the
still-unsettled audit. When the blocked token is provably
named by an in-flight audit's step text (a covered wait), a
timed-out wait SHALL charge a separate per-session bound
before blocking; uncovered waits SHALL charge the original
bound. Every timeout SHALL be logged. A path genuinely
absent from settled, verified reasoning SHALL still block.

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

#### Scenario: A covered timeout fails open on its own budget

- **GIVEN** a trace-blocked call whose unmatched token is named
  in an in-flight audit's step text and the session is below
  its covered fail-open bound
- **WHEN** the wait times out with the audit still unsettled
- **THEN** the call is allowed, the occurrence is logged, and
  the uncovered timeout budget is not charged

#### Scenario: Covered timeouts stop failing open past their bound

- **GIVEN** the session has already failed open on covered
  timeouts up to the covered bound
- **WHEN** another covered wait times out
- **THEN** the call is blocked with a reason naming the
  still-unsettled audit, and the timeout is logged

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

## ADDED Requirements

### Requirement: FR-069 Trace patterns satisfy concrete calls

A concrete operational token SHALL pass the trace check when
the verified trace carries a pattern token that is path-scoped
(contains at least one `/`) and whose compiled pattern matches
the token's full path or a slash-boundary suffix of it,
case-insensitively. A pattern token without a `/` (a bare
filename glob such as `*.md`) SHALL NOT satisfy a concrete
token. Concrete full-path and basename matching SHALL be
unchanged.

#### Scenario: A path-scoped glob covers a concrete write

- **GIVEN** the verified trace references `kb/topics/*.md`
- **WHEN** a call's operational argument is
  `kb/topics/gov-ci.md`
- **THEN** the call is not blocked by the trace check

#### Scenario: A bare filename glob does not satisfy

- **GIVEN** the verified trace references `*.md` and nothing
  else covering the call's target
- **WHEN** a call's operational argument is
  `kb/topics/gov-ci.md`
- **THEN** the call is blocked by the trace check

#### Scenario: An absolute argument matches by suffix

- **GIVEN** the verified trace references `kb/topics/*.md`
- **WHEN** a call's operational argument is an absolute path
  ending in `/kb/topics/gov-ci.md`
- **THEN** the call is not blocked by the trace check

#### Scenario: Matching is case-insensitive

- **GIVEN** the verified trace references `KB/Topics/*.md`
- **WHEN** a call's operational argument is
  `kb/topics/gov-ci.md`
- **THEN** the call is not blocked by the trace check

#### Scenario: The empty-trace allow is unchanged

- **GIVEN** no verified trace exists for the session
- **WHEN** a call carries a concrete path
- **THEN** the call is not blocked by the trace check (FR-011)

### Requirement: FR-070 Block reasons account for audit state

Trace-check block reasons SHALL be actionable in the state
that produced them. The plain not-in-trace reason SHALL name
both accepted forms of correction — naming the file explicitly
(full path or basename) or a path-scoped pattern covering it —
and SHALL direct the agent to retry after the audit settles
rather than in the same turn. When a wait for in-flight audits
settles, the call still blocks, and a departed audit's step
text named the unmatched token, the reason SHALL state that the
reasoning was audited and not recorded rather than blaming
absent reasoning.

#### Scenario: The plain reason names both corrective forms

- **GIVEN** a trace-blocked call
- **WHEN** the block is delivered with no audit in flight
- **THEN** the reason tells the agent to name the file
  explicitly or with a path-scoped pattern in verified steps,
  then retry after the audit settles

#### Scenario: An evicted correction is named honestly

- **GIVEN** a wait settles over an audit whose step text named
  the blocked token, the step was not recorded, and the
  re-evaluated check still blocks
- **WHEN** the block is delivered
- **THEN** the reason states that the recent reasoning named
  the path but its audit did not pass, directing a factual
  restatement

#### Scenario: Uncovered waits keep the original budget

- **GIVEN** a trace-blocked call whose unmatched token is
  named by no in-flight audit
- **WHEN** the wait times out
- **THEN** the fail-open charges the original uncovered
  per-session bound (FR-067)
