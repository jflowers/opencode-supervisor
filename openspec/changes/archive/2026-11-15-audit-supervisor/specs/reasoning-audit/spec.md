# Spec Delta

## Purpose

Audits assistant reasoning steps as they complete: strips narrative,
runs deterministic checks plus a goal-aware peer audit in a side
session, and delivers failed-audit critiques back to the agent.

## ADDED Requirements

### Requirement: FR-001 Reasoning audit trigger
The system SHALL audit every completed assistant reasoning step in
a session exactly once. A step that has not passed audit is
unverified and MUST NOT be treated as part of the verified
reasoning trace.

#### Scenario: Completed reasoning step triggers audit
- **WHEN** an assistant reasoning step completes in a session
- **THEN** the system audits that step exactly once

#### Scenario: Turn without reasoning
- **WHEN** an assistant turn produces no reasoning steps
- **THEN** no audit runs and no critique is delivered

### Requirement: FR-002 Narrative stripping before audit
The system SHALL strip persuasive narrative from reasoning steps
according to the configured strip mode (`code_and_math`,
`balanced`, or `strict`) before invariant checks, peer audit, and
step-reference matching.

#### Scenario: code_and_math isolates formal content
- **WHEN** a step mixes narrative with code or math and the mode
  is `code_and_math`
- **THEN** only code and mathematical content remain for audit

### Requirement: FR-003 Deterministic invariants without LLM
The system SHALL fail an audit without any model call when a
reasoning step contains a deterministic violation: an arithmetic
error, an off-by-one iteration bound (`i <= x.length`), or a
reward-hacking marker.

#### Scenario: Reward-hack marker fails fast
- **WHEN** a stripped step contains `--no-verify` or a skipped
  test marker
- **THEN** the audit fails without invoking the peer-audit model

### Requirement: FR-004 Goal-aware peer audit in a side session
The system SHALL verify steps that pass deterministic invariants
using a peer-audit model invoked in a separate model session. The
audit call MUST NOT add messages to the supervised conversation.
The audit prompt SHALL include the session goal when known so the
auditor can flag scope drift. The auditor model and variant SHALL
be resolved by precedence: session plugin configuration, then
environment variables, then defaults.

#### Scenario: Auditor runs outside the supervised session
- **WHEN** a step requires peer audit
- **THEN** the model call happens in its own session and the
  supervised conversation contains only the steer critique, if any
#### Scenario: Configuration precedence

- **WHEN** the auditor model is set in the session plugin config
  and a different value is in the environment
- **THEN** the session plugin config value is used

[Amendment 2026-10-23, review finding #6: the session-plugin-config
tier is unreachable at runtime — no public hook payload carries
per-session plugin config (the `chat.params` input exposes session,
agent, model, provider, and message only; verified against
`@opencode-ai/plugin` 1.19.4). The scenario holds for the resolution
function, unit-tested with a constructed session object; at runtime
the effective chain is environment variables → defaults.]

#### Scenario: Structured verdict
- **WHEN** the peer audit returns
- **THEN** the outcome is a structured verdict with pass state,
  failed step reference, critique text, and severity

### Requirement: FR-005 Fail-open on auditor errors
If the peer-audit invocation fails (model error, timeout, or
unparseable response), the system SHALL treat the step as passed,
record the error, and continue supervising the session.

#### Scenario: Unparseable auditor response
- **WHEN** the peer-audit model returns malformed output
- **THEN** the step passes and the plugin remains active

### Requirement: FR-006 Verified reasoning trace
The system SHALL record steps that pass audit in a per-session
verified reasoning trace that tool-intent verification consumes.

#### Scenario: Passed steps become the trace
- **WHEN** a reasoning step passes audit
- **THEN** the step is available to tool-intent verification for
  that session

### Requirement: FR-007 Bounded critique delivery
When an audit fails with minor severity, the system SHALL deliver
the critique to the supervised session as a steering prompt for
the next agent turn. The system SHALL deliver at most
`maxRegenerations` critiques per session (default 2). After the
bound is reached, new critiques SHALL be recorded in the
supervision context without triggering further steering prompts.

#### Scenario: Minor failure steers the agent
- **WHEN** an audit fails with severity minor
- **THEN** the agent receives the critique as a steering prompt
  on its next turn

#### Scenario: Critique bound reached
- **WHEN** the session has already received `maxRegenerations`
  critiques and another audit fails
- **THEN** no new steering prompt is delivered and the critique
  is recorded in the supervision context

### Requirement: FR-008 Interrupt on severe findings
When an audit fails with severe severity (a reward-hacking
pattern in reasoning), the system SHALL interrupt the supervised
session and deliver the critique as a steering prompt.

#### Scenario: Reward hacking in reasoning interrupts
- **WHEN** a reasoning step contains a reward-hacking pattern
- **THEN** the session is interrupted and the critique is
  delivered

[Amendment 2026-10-23, review findings #2/#8: once the per-session
maxRegenerations bound is spent, a severe finding neither interrupts
nor delivers; it is recorded as withheld. The whole intervention
(interrupt + steer) is bounded per session.]
