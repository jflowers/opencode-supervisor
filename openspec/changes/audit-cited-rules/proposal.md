# Proposal

## Why

A live `/uf.unleash` run (session `ses_df0b08645ffelKBy3yKlHxWjVz`,
GLM 5.3, opencode 1.19.0) stopped on a false audit finding. The
`/opsx-propose` entry delegation at tier-routing substep 5 timed out
at its default 600 s wall clock while the child was still working.
The agent planned to re-delegate with `timeout: 1800000`. The
auditor failed that plan with: "Spec substeps 5/6 require 'emit
envelope error and STOP' on failure/timeout ... Extending timeout
without human instruction violates delegation budget contract."

Neither claim matches the goal text. Substep 5 has no failure
handling; "emit the envelope's message and STOP" belongs to the
substep 6 branch-gate check. "Pass one only when the human
instructs" is scoped to the per-task implement delegations of
Step 5, not the tier-routing entry delegation. The agent's reasoning
noticed that "substep 5 doesn't literally say that", then deferred
to "the supervisor's authoritative interpretation" and stopped.

The auditor paraphrased a rule into existence and stretched a scoped
rule over a step it does not cover. Nothing checks a goal-based
finding against the text it claims to apply.

## What Changes

- FR-113 (new): a peer-audit finding that rests on the session goal
  or engineer directives MUST quote the rule it applies, verbatim,
  in a new verdict field `rule`. The auditor prompt says so, and
  says a rule applies only within the scope its own text gives it
  (a rule written for one step, phase, or call does not govern
  another) and that a step the text does not address is not a
  violation.
- The plugin checks each quoted rule against the goal and directive
  text the audit was given (whitespace, case, quote style, and
  markdown emphasis normalized). A rule that is not found, or is
  shorter than four words, drops the finding: the audit fails open
  (FR-005), the step passes, and the drop is logged with the quote.
- A verified rule is appended to the delivered critique as
  `Rule cited: "<rule>"`, so the agent can check the finding
  against its own instructions.
- Findings with no `rule` (arithmetic, boundary, security, reward
  hacking) are unchanged.

Considered and not done:

- Checking quoted spans inside the critique text. Critiques quote
  steps as well as rules, so a free-text check cannot tell which
  quote is the rule.
- Telling the agent it may ignore a finding it disagrees with. That
  weakens every true finding to fix the false ones; the check
  belongs on the auditor side.
- A second model pass to judge rule scope. Scope stays a prompt
  instruction; the verbatim check catches invented rules, and the
  delivered quote lets the agent see a misapplied one.

## Capabilities

### Modified Capabilities

- `reasoning-audit`: FR-113.

## Impact

- Code: `src/auditor.ts` (prompt text, `rule` parsing,
  `verifyCitedRule`, `runPeerAudit`).
- Tests: `test/audit.test.ts`.
- Docs: README 4.1, CHANGELOG.
