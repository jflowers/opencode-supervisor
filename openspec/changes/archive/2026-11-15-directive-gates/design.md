# Design

## Context

The engineer console loads directives once at plugin start
(fail-open, FR-032) and enforces `forbidPath`/`forbidPattern`
rules inside the pure tool guard (`verifyToolIntent`,
`src/tool-guard.ts`) using `extractPolicyPaths` candidates.
The verified trace (`SessionState.verifiedSteps`) records
reasoning steps that passed peer audit; the FR-011 trace
check consults it only when globally enabled and never on an
empty trace. The `request_audit` tool (FR-037) appends passed
focus text to the same trace. The hooks API offers no
interactive approval channel: `tool.execute.before` can only
block with a reason.

## Goals / Non-Goals

**Goals:**

- Two new rule kinds (`approve`, `review`) on the existing
  fence, loaders, bounds, and warnings.
- An approval channel that works without restarts and
  without new hook API surface.
- Review gates that reuse the verified trace as the
  sign-off record, composable with `request_audit`.

**Non-Goals:**

- No memo section for pending gates (the block reason and
  the grant log carry the signal; a pending-gate queue can
  be a follow-up).
- No changes to the existing four rule kinds, the guard
  signature, or the automatic audit loop.
- No approvals TTL/`note` semantics beyond expiry skipping.
- No interactive prompts to the engineer.

## Decisions

### D1: Module split — directives parses, gates evaluate

`src/directives.ts` gains `ApproveRule`/`ReviewRule` types
and `normalizeApproveRules`/`normalizeReviewRules` wired
into both parsers (the fence format is directives-domain).
A new pure module `src/gates.ts` owns compilation and
evaluation: `compileGates`, `matchApproveGates`,
`parseApprovals`, `approvalMatches`, and
`evaluateReviewGates`. `index.ts` wires the hook and owns
the approvals file read.

*Alternative*: extending `tool-guard.ts`. Rejected — the
guard's seam (`verifyToolIntent(toolCall, verifiedSteps,
config, enforcement)`) is pure and tested; approvals need
verification-time filesystem reads that do not belong there.

### D2: Two-phase gate evaluation keeps I/O out of the hot path

`tool.execute.before` runs the existing guard first (a
forbidden path never reaches the gate question), then:
(1) `matchApproveGates` — pure, no I/O — returns the matched
gate key and block skeleton or null; (2) only on a match,
`index.ts` reads `.opencode/supervisor/approvals.json` fresh
and calls pure `approvalMatches`; (3) `evaluateReviewGates`
— pure — checks the verified trace. Un-gated calls pay one
pure matcher; gated calls pay one file read. Approvals and
revocations take effect on the next matching call because
nothing is cached.

Implementation amendment: the gate phase as a whole is skipped
for the plugin's own agent-console tools (`remind_me`,
`forget_reminder`, `recall`, `report`, `request_audit`). The
exemption set is DERIVED from the registered tool map (the
keys of `hooks.tool` in `index.ts`) rather than a
hand-maintained list, so a future sixth console tool is exempt
automatically. Gates guard the agent's
effectors — tools that change the world — not the supervision
channel itself: the review-gate block reason points the agent at
`request_audit`, so leaving that channel gated would deadlock
the advertised unblock path (a review gate on the touched path
would otherwise block the very audit that satisfies it).

### D3: Gate keys are explicit or derived

A gate key is the rule's explicit `id` when present, else
`<directiveId>/<ruleIndex>`. Explicit ids survive rule
reordering; derived keys are stable within a load. The block
reason states the key verbatim so the approval instruction
is copy-pasteable.

### D4: Approvals file semantics — fresh, bounded, ENOENT-vs-error

`.opencode/supervisor/approvals.json` is a JSON array of
`{gate, note?, expires?}`. Parsing bounds the record set to
the most recent `MAX_APPROVALS` (50) entries; records with a
past `expires` date never match. The read distinguishes:

- **ENOENT** — empty record set: the call blocks with the
  approval instruction (absence is the unapproved state, not
  an error; the common case before any approval exists).
- **EACCES / parse failure / wrong shape** — fail-closed
  block carrying the error (FR-045): once a gate matches,
  its check must not silently dissolve. This is the
  documented contrast with load-time fail-open (FR-032),
  which governs directive *loading*, not gate verification.

*Alternative*: fail-open verification with a warning.
Rejected — an engineer who declared a gate would silently
lose it exactly when the approvals file is corrupted.

### D5: Review gates check the trace for gate-matched paths

Candidate paths come from `extractPolicyPaths`; the paths
that match a review rule's glob are the ones that must be
trace-referenced. Reference matching reuses the FR-011
semantics (a verified step references a path when its text
contains it, case-insensitive). Review gates block on an
empty trace — deliberately stricter than FR-011's global
empty-trace carve-out, because the gate is explicit engineer
policy and `request_audit` gives the agent a constructive
path to populate the trace and retry. The block reason names
the path and the audit-first instruction.

### D6: Grant logging follows the trigger precedent

The first grant per gate key per session logs
`[supervisor] gate '<key>' of directive '<directiveId>'
approved for tool '<tool>'` (constitution III: load, skip,
block, trigger, approve — FR-046 requires the directive to be
identified); later grants through the same key are silent,
mirroring `triggeredDirectives`. A `grantedGates: Set<string>`
on `SessionState` tracks first grants and clears on dispose.

### D7: Rule validation mirrors the existing kinds

`normalizeApproveRules` accepts objects with optional string
`id`, `tool`, `path`, `pattern` — at least one of
`tool`/`path`/`pattern` required (an empty rule would match
every call); `normalizeReviewRules` requires `path` (a
review rule without a path is meaningless). Invalid rules
drop with a warning; `MAX_RULES_PER_DIRECTIVE` (10) applies
per kind; loading stays fail-open. Compilation follows
`compileEnforcement`: globs via `globToRegExp`
(case-insensitive), regexes via `new RegExp` with
invalid-pattern skip-and-warn.

## Risks / Trade-offs

- [Approvals file is plantable by the supervised agent]
  → Same trust class as directive files themselves (the
    platform already grants the project directory plugin
    power); documented in README §9 alongside the directive
    trust note. Fail-closed verification limits a corrupted
    file to blocking, never to silently admitting.
- [Derived keys shift when rules reorder] → Explicit `id`
    documented as the stable choice for long-lived gates.
- [Review gates block first calls of a session] →
  Intentional (D5); the block reason teaches the
  `request_audit` path, and the automatic loop populates the
  trace as reasoning completes.
- [One file read per gated call] → Bounded by gate
  frequency; no read on un-gated calls (D2).

## Migration Plan

Additive: no existing rule kind, config key, or signature
changes. Directives without `approve`/`review` rules behave
identically; the approvals file is consulted only when a
gate matches. Rollback is revert; no state migrates.
