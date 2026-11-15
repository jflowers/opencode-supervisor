# Proposal

## Why

The engineer console (2.2.0) can forbid and surface, but it
cannot defer: an engineer who wants destructive or risky work
to wait for explicit sign-off has no mechanism short of an
outright `forbid` rule, and one who wants a peer-audited plan
before a file is touched must rely on the global, off-by-
default trace check. Both roadmap rule kinds — approve-gates
and required reviewers — close this gap on the same
directive loader, fence format, and session-state layer.

## What Changes

- **Approval gates (`approve` rules)**: a new directive rule
  kind `{ id?, tool?, path?, pattern? }`. A matching tool call
  is blocked with an actionable reason naming the directive,
  the gate key, and the exact approval instruction: add
  `{"gate": "<key>"}` to `.opencode/supervisor/approvals.json`.
  The gate key is the rule's explicit `id`, or
  `<directiveId>/<ruleIndex>` when omitted.
- **Approval records**: an engineer-authored JSON array
  `[{"gate", "note?", "expires"?}]` at
  `.opencode/supervisor/approvals.json`, read fresh at each
  gated match — approval and revocation take effect without a
  restart. `expires` (YYYY-MM-DD) entries stop matching after
  their date. Revocation is entry removal.
- **Fail-closed verification**: once an approve rule matches,
  an unreadable or malformed approvals file blocks the call
  with the read/parse error (documented contrast with the
  load-time fail-open of FR-032: a matched gate's check must
  not silently dissolve).
- **Approved gates proceed and are logged**: an unexpired
  matching approval lets the call through and logs the grant
  (constitution III observability: load, skip, block,
  trigger, approve).
- **Review gates (`review` rules)**: a new directive rule
  kind `{ path }`. A matching tool call is blocked unless the
  verified trace (passed peer audits) references the touched
  path — the directive-declared, path-scoped form of the
  FR-011 trace check. Review gates deliberately block on an
  empty trace: the gate is explicit engineer policy, and the
  `request_audit` tool gives the agent a constructive path to
  populate the trace and retry.
- **Shared rule plumbing**: both kinds ride the existing
  fence format and loaders with the same validation,
  warnings, per-kind `MAX_RULES_PER_DIRECTIVE` slice,
  case-insensitive glob matching, and `extractPolicyPaths`
  candidates; parse-time handling stays fail-open (invalid
  rules are skipped with a warning).

## Capabilities

### New Capabilities

- `directive-gates`: approval gates and review gates — the
  defer-and-sign-off half of the engineer console. Owns
  approve/review rule declaration, approval records, gate
  verification (fail-closed), grant logging, and review-gate
  trace requirements.

### Modified Capabilities

- `engineer-directives`: the directive file format and
  options channel gain `approve` and `review` rule kinds in
  the supervisor fence (parsing, bounds, warnings extend the
  existing kinds).

## Impact

- `src/directives.ts`: `ApproveRule`/`ReviewRule` types,
  `normalizeApproveRules`/`normalizeReviewRules` wired into
  both parsers; `Directive` gains optional `approve`/`review`
  arrays.
- New `src/gates.ts` (pure): gate compilation, approve-gate
  matching, approval-record parsing/matching, review-gate
  evaluation.
- `index.ts`: compile gates at server start; in
  `tool.execute.before`, evaluate approve gates after the
  existing guard (fresh approvals read only when a gate
  matches), evaluate review gates against the verified trace;
  log approved grants.
- `test/gates.test.ts` (new) plus targeted additions to
  `test/directives.test.ts`.
- Docs: README §7.5/§6/§9/§10, AGENTS.md, CHANGELOG 2.4.0.
- No breaking changes; existing enforce/when directives and
  all four existing rule kinds are unaffected.
