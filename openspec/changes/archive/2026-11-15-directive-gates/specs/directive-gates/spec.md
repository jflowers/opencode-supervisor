# Spec Delta

## Purpose

Approval gates and review gates: the defer-and-sign-off half
of the engineer console. Approve rules hold matching tool
calls until the engineer records an approval; review rules
hold them until a passed peer audit references the touched
path.

## ADDED Requirements

### Requirement: Approval gate blocking

The plugin SHALL support `approve` rules in the supervisor
fence, each an object with optional `id`, `tool`, `path`
(glob), and `pattern` (regex) fields. A matching tool call
SHALL be blocked with a reason naming the directive, the
gate key, and the approval instruction: add `{"gate":
"<key>"}` to the approvals file. Matching follows
enforcement-rule semantics (FR-028).

#### Scenario: gate blocks an unapproved call
- **WHEN** a directive declares `approve: [{id: "deploy"}]`
      and a tool named `bash` is called
- **THEN** the call is blocked and the reason includes
      directive id, the gate key `deploy`, and the
      instruction to add `{"gate": "deploy"}` to
      `.opencode/supervisor/approvals.json`

#### Scenario: gate key defaults from rule position
- **WHEN** an approve rule omits `id` and sits at index 1
      of directive `prod-guard`
- **THEN** its gate key is `prod-guard/1`

#### Scenario: path-scoped approve gate
- **WHEN** an approve rule declares
      `path: "infra/**"` and a tool call's arguments touch
      `infra/terraform/main.tf`
- **THEN** the call is blocked by that gate

#### Scenario: non-matching call proceeds
- **WHEN** a tool call matches no approve rule
- **THEN** approval evaluation returns no block

#### Scenario: agent-console tools stay reachable
- **WHEN** a call to a tool the plugin itself registers in its
      agent console (`remind_me`, `forget_reminder`, `recall`,
      `report`, `request_audit`) matches an approve rule
- **THEN** the call proceeds without gate evaluation, keeping
      the supervision channel reachable

### Requirement: Approval records

The plugin SHALL read approval records from
`.opencode/supervisor/approvals.json`: a JSON array of
objects with `gate` (string), optional `note` (string), and
optional `expires` (YYYY-MM-DD string). The file SHALL be
read fresh when an approve gate matches — approvals and
revocations take effect on the next matching call without a
restart. Records with a past `expires` date SHALL NOT match.
The stored record set SHALL be bounded to the most recent
entries by a fixed cap.

#### Scenario: recorded approval admits the call
- **WHEN** gate `deploy` matches and the approvals file
      contains `{"gate": "deploy"}`
- **THEN** the call proceeds and the grant is logged

#### Scenario: expired approval does not admit
- **WHEN** gate `deploy` matches and the only record for it
      expired yesterday
- **THEN** the call is blocked with the approval
      instruction

#### Scenario: revocation takes effect without restart
- **WHEN** an engineer removes gate `deploy` from the
      approvals file
- **THEN** the next call matching gate `deploy` is blocked

#### Scenario: the agent cannot self-approve
- **WHEN** a supervised tool call's arguments reference the
      approvals file (any path whose basename is
      `approvals.json`)
- **THEN** the call is blocked with a reason naming the
      approvals file as engineer-authored state, so the
      supervised agent cannot self-approve a gate

### Requirement: Approval verification fails closed

When an approve rule matches and the approvals file cannot
be read or parsed, the call SHALL be blocked with a reason
that carries the read or parse error. This verification-time
behavior contrasts with the load-time fail-open of FR-032: a
matched gate's check MUST NOT silently dissolve.

#### Scenario: malformed approvals file blocks
- **WHEN** gate `deploy` matches and the approvals file
      contains invalid JSON
- **THEN** the call is blocked and the reason reports the
      parse failure

#### Scenario: absent approvals file is empty set
- **WHEN** gate `deploy` matches and no approvals file
      exists
- **THEN** the call is blocked with the approval
      instruction (absence is an empty record set, not an
      error)

### Requirement: Approved grants are logged

When an approval admits a call through a gate, the plugin
SHALL log the grant once per granted gate key, identifying
the directive, gate, and tool call.

#### Scenario: grant logged
- **WHEN** gate `deploy` admits a `bash` call
- **THEN** a log line records the approved grant

### Requirement: Review gate trace requirement

The plugin SHALL support `review` rules in the supervisor
fence, each an object with a `path` glob. When a tool call's
arguments touch a path matching a review rule, the call
SHALL be blocked unless the verified trace contains a passed
step referencing that path. Review gates SHALL block on an
empty verified trace. The block reason SHALL state the
required path and instruct the agent to reason about the
path and pass a peer audit first (including via the
`request_audit` tool) before retrying.

#### Scenario: review gate blocks without trace reference
- **WHEN** a directive declares `review: [{path:
      "src/billing/**"}]` and a tool call touches
      `src/billing/invoice.ts` with no verified step
      referencing it
- **THEN** the call is blocked naming the path and the
      audit-first instruction

#### Scenario: trace reference admits the call
- **WHEN** the verified trace contains a passed step
      referencing `src/billing/invoice.ts` and a tool call
      touches that path
- **THEN** the call proceeds

#### Scenario: empty trace blocks review-gated paths
- **WHEN** the verified trace is empty and a tool call
      touches a review-gated path
- **THEN** the call is blocked with the audit-first
      instruction

#### Scenario: agent-console tools stay reachable
- **WHEN** a call to a tool the plugin itself registers in its
      agent console (`remind_me`, `forget_reminder`, `recall`,
      `report`, `request_audit`) matches a review rule
- **THEN** the call proceeds without gate evaluation, keeping
      the supervision channel reachable

### Requirement: Gate rule bounds and parse hygiene

Approve and review rules SHALL share the directive parse
pipeline: invalid rules (wrong shape, missing fields) are
skipped with a warning; each directive SHALL hold at most 10
rules of each kind (excess dropped with a warning); parse
failures never abort loading of other directives or the
plugin. Glob matching SHALL be case-insensitive, and
approve/review path candidates SHALL come from the same
policy path extraction as enforcement rules.

#### Scenario: invalid approve rule skipped with warning
- **WHEN** a fence declares `approve: [{"tool": 42}]`
- **THEN** the rule is dropped, a warning is emitted, and
      the directive's other rules load

#### Scenario: rule-kind bound applies per kind
- **WHEN** a directive declares 12 approve rules and 12
      review rules
- **THEN** 10 of each are kept and a warning reports the
      drops
