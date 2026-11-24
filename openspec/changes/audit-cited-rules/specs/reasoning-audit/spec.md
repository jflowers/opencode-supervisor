# reasoning-audit

## ADDED Requirements

### Requirement: FR-113 goal-based findings quote a rule that exists

The audit prompt MUST tell the auditor that a finding resting on
the session goal or engineer directives quotes the rule it applies,
verbatim, in the verdict's `rule` field; that a rule applies only
within the scope its own text gives it; and that a step the text
does not address is not a violation. A failed peer verdict with a
`rule` MUST be checked against the goal and directive text given to
that audit, with whitespace, case, quote characters, and markdown
emphasis normalized. When the rule is not found there, or has fewer
than four words, the finding MUST be dropped: the audit fails open
(FR-005), the step passes, and the recorded error names the quote.
A verified rule MUST be delivered with the critique as
`Rule cited: "<rule>"`. A failed verdict without a `rule` MUST be
handled as before.

#### Scenario: rule paraphrased into existence

- **GIVEN** the goal says "On failure, emit the envelope's message
  and **STOP**" only for a branch-gate check
- **WHEN** the auditor fails a step citing the rule "Spec substeps
  5/6 require emit envelope error and STOP on timeout"
- **THEN** the audit passes with an error naming the quote
- **AND** no critique is delivered

#### Scenario: rule quoted verbatim

- **GIVEN** the goal says "Do not edit any code before debug_open
  succeeds"
- **WHEN** the auditor fails a step citing "do not edit any code
  before debug_open succeeds"
- **THEN** the audit fails and the critique ends with
  `Rule cited: "do not edit any code before debug_open succeeds"`

#### Scenario: finding without a rule

- **WHEN** the auditor fails a step for an off-by-one error with no
  `rule`
- **THEN** the audit fails with the critique unchanged
