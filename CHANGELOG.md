# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.8.0] - 2026-11-01

### Added

- Trace-side pattern satisfaction (FR-069): a concrete file-path tool
  argument now passes the trace check when the verified reasoning trace
  carries a path-scoped pattern (at least one directory segment, e.g.
  `kb/topics/*.md`) whose compiled glob matches the argument's full path
  or a slash-boundary suffix of it, case-insensitively. Bulk workflows
  that reason in globs before batched writes no longer block on every
  concrete file. Bare filename globs (`*.md`) still cover nothing, and
  explicit full-path/basename matching is unchanged.
- Pending-audit-aware relief and reasons (FR-070): in-flight audits now
  register with the path tokens of the stripped step they are auditing.
  A trace block whose unmatched path is provably named by an in-flight
  audit (a covered wait) fails open on timeout against a separate
  per-session cap — `maxCoveredTimeoutFailOpens` (default 6, full
  precedence chain) — blocking past the cap with the still-unsettled
  audit named; uncovered timeouts keep charging `maxTimeoutFailOpens`.
  Trace-check block reasons are now honest about audit state: the plain
  reason names both corrective forms (explicit path/basename or a
  path-scoped pattern) and directs a retry after the audit settles
  rather than in the same turn, and a settled wait whose correction was
  audited but evicted says so instead of blaming absent reasoning.

### Changed

- `pendingAudits` session state is a `Map` from each audit continuation
  to the path tokens of the stripped step it audits (was a `Set` of
  promises).
- Agent-authored path patterns no longer compile to regular
  expressions at all. The shared matcher (`globPathMatches`) is a
  total, bounded dynamic-programming glob match — it cannot throw
  on adversarial spellings (an unterminated character class such
  as `src/[\].md` used to crash the compiler into the hook's
  fail-open path) and runs in O(pattern × subject) instead of
  catastrophic backtracking. Both sides are capped (pattern over
  512 characters or more than 32 wildcards; full-path matches
  reject subjects over 512 characters, suffix matches may match
  via a slash-boundary suffix within that cap) and every match in
  one guard call — DP cells and per-pair scan work alike —
  shares a 4M-cell aggregate work budget that fails closed when
  exhausted, so agent-authored pattern counts cannot multiply
  the work. A rejected *call* pattern names the complexity bounds
  in its block reason, and an exhausted budget gets its own
  distinct block reason naming the exhaustion; rejected
  trace-side patterns and over-cap subjects match nothing
  (review hardening, iterations 1-4).
  Engineer-authored directive globs are unchanged.
- Protected-state matching now fails toward blocking on over-long
  glob segments: a glob-bearing segment over 4096 characters is
  treated as a match for the protected supervisor paths rather
  than a non-match, so an absurd segment cannot slip past the
  protected-state check (review iteration 3).
- `extractPathTokens` deduplication is now Set-backed (was
  `Array.includes`), O(n²) → O(n) in token count — adversarial
  reasoning parts carrying tens of thousands of distinct path
  tokens no longer stall the event hook (review iteration 3).
- API stability: `pendingAudits` (Set → Map) and the new required
  `HookConfig.maxCoveredTimeoutFailOpens` field ship on this
  minor bump; both are plugin-internal surfaces — OpenCode loads
  `index.ts` directly and configuration flows through opencode
  plugin options, so there are no programmatic consumers of
  either shape.

Spec deltas: `openspec/changes/close-trace-check-corrective-loop/`
(base synced to `openspec/specs/trace-check/spec.md`).

## [2.7.0] - 2026-10-31

### Added

- Tool-arg repair: malformed tool-call arguments are repaired before the
  tool executes. Models occasionally emit structurally broken arguments —
  `{"questions": null}` where an array belongs, JSON-stringified arrays
  and objects, or one question call's fragments split across separate
  array elements — and OpenCode's schema error alone burns turns on
  retry loops. The `tool.execute.before` hook now validates arguments
  against the tool's JSON schema (fetched per provider/model from the
  host's tool list, cached per identity), applies deterministic repairs
  first (parse stringified values, extract embedded JSON, wrap single
  objects in arrays, merge fragment runs, drop null optionals — each
  gated by re-validation), and only then asks a repair model in a
  dedicated side session, with the calling assistant message's reasoning
  text as evidence and a strict no-invention rule: values must be
  recovered verbatim or the call is declared unrepairable. Repaired
  arguments merge in place, so the guard, the recorded tool-part input,
  and execution all see one object; repair never throws, and every
  failure path leaves the original arguments to fail normally.
- `mode` configuration: `full` (default, everything) or `repair-only` —
  the supervision hooks (reasoning audit, tool guard, memo, agent
  console) stay unregistered so the plugin runs purely as an argument
  repair pass. Settable through `OPENCODE_SUPERVISOR_MODE`, the
  supervisor config files, and plugin options.
- `argRepair` configuration block: `enabled` (default `true`), `model`
  (defaults to the resolved auditor model, inheriting its derived
  host-model fallback), `tools` (default: the OpenCode builtin tool
  ids), `maxPerSession` (default 8), `timeoutMs` (default 15000).
  Environment override: `OPENCODE_SUPERVISOR_REPAIR_MODEL`.
- `repair` directive rule kind:
  `{"repair": [{"tool": "dewey_search"}]}` adds matching tools (name or
  glob) to the repair scope — the escape hatch for MCP and plugin tools
  outside the builtin default.

### Changed

- The identity log line now names the active mode.

50 new tests (353 total) pass under Bun and Node 22+.

## [2.6.0] - 2026-10-31

Spec deltas:
`openspec/changes/repair-trace-check-pipeline/specs/trace-check/spec.md`.

### Fixed

- The arithmetic invariant now evaluates an equation's full operand
  chain instead of only its last binary pair. `38+16+2=56` was
  checked as `16+2=56`, so every correct chained sum failed the
  audit and the entire reasoning part — with it, every file path
  the part mentioned — vanished from the verified trace. Chains
  evaluate with standard operator precedence (`2+3*4=14` passes,
  `2+3*4=20` fails), division by zero still declines to judge, and
  the critique quotes the whole stated expression. A step that
  fails a minor deterministic invariant now stays in the verified
  trace marked unpassed while its critique still steers — the
  trace is a path ledger, and one misstated tally no longer
  revokes the part's file reasoning; severe findings and
  peer-audit failures still evict, and review gates match only
  passed entries (#35; `openspec/changes/repair-trace-check-pipeline`).
- The tool guard's path tokenizer now recognizes wildcard- and
  variable-bearing tokens as patterns. `kb/topics/*.md` previously
  tokenized to nothing — a silent bypass that let routed batches
  through the trace check unexamined — `"$bdir/$id.md"` produced a
  phantom demand for `id.md`, and `.js` matched inside `.json`. A
  pattern token (glob metacharacters or shell variables) now passes
  when the verified trace references a satisfying path or the pattern
  spelling itself, and otherwise blocks naming the pattern with the
  corrective action; extension matches carry a trailing boundary so
  `config.json` tokenizes whole. The shared grammar lives in the new
  `src/path-tokens.ts` leaf module, so the guard and the stripper
  recognize the same tokens (#36; FR-066).
- The trace check now scans operational arguments only. A write whose
  `content` quoted a filename the verified trace never mentioned
  blocked as an unaudited touch — authored data is not an operation.
  For tools other than bash, values under the content keys
  (`content`, `oldString`, `newString`) are skipped while every other
  argument key, including custom and MCP names, stays scanned;
  bash command strings remain operational in full. The plugin's own
  console tools are exempt from the trace check, derived from the
  registered tool map so a future console tool is covered
  automatically — `request_audit` can no longer fence its own
  channel, and the reward-hacking check still applies to it (#33;
  FR-064, FR-065).
- The tool guard now waits for in-flight audits before blocking on
  the trace check. A same-turn tool call used to race the audit of
  the very reasoning that named its paths — the call saw the
  partial trace and blocked with a corrective instruction the agent
  had already followed. A trace block with an audit in flight now
  waits up to 10 seconds (`Promise.allSettled` raced against a
  timer cleared on every path; a rejected continuation counts as
  settled, is logged once, and never throws into the hook), then
  re-checks the settled trace; on timeout the call fails open —
  the live agent's progress outranks one unverified call — up to
  `maxTimeoutFailOpens` per session (default 3, env
  `OPENCODE_SUPERVISOR_MAX_TIMEOUT_FAIL_OPENS`), past which a
  timed-out wait blocks naming the still-unsettled audit. Passing
  calls, settled traces, the empty-trace allow, and reward-hacking
  and directive blocks never charge the wait (#34; FR-067).
- Path-bearing steps survive narrative stripping in `code_and_math`
  and `balanced`. Prose naming a file (*"I will update notes.md"*)
  was stripped before the audit, so the path never reached the
  verified trace and the guard's corrective instruction could not
  be followed — the loop was unclosable. A step carrying a
  path-like token (the shared `src/path-tokens.ts` grammar) now
  survives both modes with narrative-prefix removal intact;
  `strict` is unchanged. Wiring the stripper to the shared grammar
  also exposed and fixed a latent cursor-sharing hazard there: a
  module-level global regex leaked `lastIndex` between
  `hasPathToken` probes and `matchAll` extraction, silently
  shifting the guard's token offsets — the grammar now compiles per
  call site (#34; FR-068).

27 new tests (303 total) pass under Bun and Node 22+.

## [2.5.0] - 2026-10-30

### Fixed

- The supervisor no longer logs to stdout/stderr. Every diagnostic
  now routes to the OpenCode server log through the SDK client's
  `/log` endpoint (service tag `opencode-supervisor`), so
  `[supervisor]` lines no longer interleave with and corrupt the
  TUI. Delivery is fire-and-forget with absorbed rejections (a
  server listener that is not up yet at bootstrap loses only the
  line), warn/error entries dedupe per message so per-step
  fail-open loops cannot spray, and the identity line logs once at
  the first hook invocation (FR-052..FR-055;
  `openspec/changes/fix-supervisor-logging`).

### Changed

- No hardcoded auditor model. The `google/gemini-3.8-flash` default
  — a slug most hosts serve no provider for, which made every audit
  side session fail with `ProviderModelNotFoundError` and silently
  fail open — is gone. The auditor model now resolves per tier:
  environment (`OPENCODE_SUPERVISOR_MODEL`) → project
  `.opencode/supervisor/config.json` → plugin tuple `options.config`
  → global `${XDG_CONFIG_HOME:-~/.config}/opencode/supervisor/config.json`
  → the host's OpenCode `small_model`/`model`. With no model
  anywhere, the LLM audit tier is skipped — deterministic
  invariants, the tool guard, and the memo remain active — and one
  warning names the state. The auditor variant is optional and is
  omitted from the side-session prompt when unset (FR-056..FR-060).
- Memo delivery moved from `experimental.chat.system.transform`
  to `experimental.chat.messages.transform`: OpenCode 1.19.0
  discards system-transform payload mutations (the request is
  built from the pre-hook system array; verified by gateway wire
  capture, which also exonerated the gateway and the AI SDK
  chain). The memo now rides one trailing user message per user
  prompt — transform-time only, never persisted to the session,
  rebuilt fresh each turn — a payload shape wire-verified on the
  same build. Memo content, bounds, and configuration are
  unchanged; the dead system-transform registration was removed
  (keeping both would double-deliver on a fixed OpenCode build).
  Evidence and decision record:
  `openspec/changes/audit-supervisor/design.md` (FR-016).
- README overhauled: lede-first opening, a "what it catches" failure
  mode table, quickstart promoted to Section 3, a mermaid diagram of
  the supervision loop, and historical content (research origin, 1.x
  migration table, future directions) compressed into a bottom
  appendix. The shipped-roadmap section was removed — the feature list
  and this changelog own that history. Docs-only: no behavior changed;
  every configuration knob, tool, rule kind, and limitation remains
  documented (#28).
- The standalone skill (`skills/reasoning-auditor/skill.md`) tracks
  the middleware: 1.0.0 → 1.1.0, referencing the host's configured
  model instead of the retired `google/gemini-3.8-flash` slug. A
  specific auditor model can still be set through the skill
  frontmatter or the OpenCode config. Users who installed the skill
  standalone should re-copy it into
  `~/.config/opencode/skills/reasoning-auditor/` (README §8).

### Migration notes

- `resolveHookConfig`'s signature extended additively: session
  overrides keep their 2.4.0 position (first argument), and the new
  sources object (`{ project, global, options, derivedModel }`) is an
  optional second argument. Existing callers work unchanged.
- `createInvokeModel` accepts the logger as an optional third
  argument: two-argument callers keep working — side-session delete
  failures fall back to silence rather than throwing.
- The supervisor config files (`<project>/.opencode/supervisor/config.json`,
  `${XDG_CONFIG_HOME:-~/.config}/opencode/supervisor/config.json`)
  are read once per server start and are now agent-write-protected:
  supervised tool calls touching them — or the directives
  directory — are blocked, like the approvals file (supervised
  agents can no longer edit directive files either). Edit them as
  the engineer, then restart OpenCode to apply.
- `AuditConfig.auditorModel` is now `string | undefined` — the one
  type-visible change on the exported TypeScript surface. The release
  stays a minor: the plugin ships as source executed directly by the
  OpenCode host, so there are no compiled downstream type consumers
  (the consumer set is this repo's tests plus the host runtime, which
  passes config objects), and the runtime config surface is unchanged.

## [2.4.0] - 2026-10-26

Spec deltas:
`openspec/changes/directive-gates/specs/directive-gates/spec.md`,
`openspec/changes/directive-gates/specs/engineer-directives/spec.md`.

### Added

- `directive-gates` capability spec (FR-043..FR-048): the engineer
  console's defer-and-sign-off half — approval gates and review
  gates as new rule kinds on the existing directive fence and
  loader.
- Approval gate blocking (FR-043): `approve` rules
  (`id?`, `tool?`, `path?` glob, `pattern?` regex) hold matching
  tool calls with a block reason naming the directive, the gate
  key, and the exact approval instruction; matching follows
  `enforce` (FR-028) semantics.
- Approval records (FR-044): `.opencode/supervisor/approvals.json`
  — a JSON array of `{gate, note?, expires?}` (most recent 50
  kept) — is read fresh at each gated call, so approvals and
  revocations take effect on the next matching call with no
  restart; expired entries stop matching (expiry day inclusive).
- Fail-closed verification (FR-045): an unreadable or malformed
  approvals file blocks the gated call carrying the error, while
  an absent file means "not approved" and blocks with the
  instruction — in contrast to the load-time fail-open contract
  (FR-032).
- Grant logging (FR-046): each granted gate key logs once per
  session, naming directive, gate, and tool (constitution III
  observability: load, skip, block, trigger, approve).
- Review gates (FR-047): `review` rules (`path` glob) hold
  matching tool calls until the verified trace references the
  touched path — the peer auditor is the required reviewer and
  the `request_audit` tool can produce the sign-off immediately;
  review gates deliberately block on an empty trace.
- Gate rule parse hygiene (FR-048): approve/review rules share the
  directive fence validation, per-kind bound (10), warnings, and
  fail-open loading; advisory rendering never includes gate
  internals.
- Engineer-directives delta: the fence and `options.directives`
  tuple channel accept `approve` and `review` arrays alongside
  `enforce` and `when`.
- Anti-self-approval default (review round 1): tool calls from
  the supervised agent that touch the approvals file (any path
  whose basename is `approvals.json`) are blocked — the agent
  cannot self-approve a gate through its own tools.
- Approvals reads are size-bounded (64 KiB; larger files fail
  closed with the size error), every matching approve gate is
  evaluated (overlapping policies block on the first
  unapproved gate), and review-gate path matching survives
  trailing-slash argument spellings.

### Changed

- `tool.execute.before` evaluates gates after the guard verdict;
  the plugin's own agent-console tools are exempt from both gate
  kinds (gates guard the agent's effectors, not the supervision
  channel the block reasons point at — `request_audit` must stay
  reachable). The exemption set is derived from the registered
  tool map, not a hand-maintained list.

47 new tests (229 total) pass under Bun and Node 22+.

## [2.3.0] - 2026-10-25

Spec deltas:
`openspec/changes/supervisor-tools/specs/supervisor-tools/spec.md`.

### Added

- `supervisor-tools` capability spec (FR-033..FR-042): the agent
  console's second slice — recall, report, and on-demand audit.
- `recall` tool (FR-033): reads the full retained supervision state
  (`goal`, `reminders`, `solved`, `critiques`, or `all`), beyond the
  memo's recency caps; read-only, with actionable listings for
  unsupported section names.
- `report` tool (FR-034): records a self-reported event as one of four
  kinds (`blocker`, `deviation`, `outcome`, `note`) with reminder-grade
  text hygiene (whitespace rejection, 2000-character truncation) and an
  echoing tool result.
- Report storage bounds (FR-035): the most recent
  `memoLimits.maxReports` reports are kept (default 5;
  `OPENCODE_SUPERVISOR_MEMO_MAX_REPORTS`).
- `Agent reports:` memo section (FR-036) rendered between solved items
  and critiques, omitted when empty.
- `request_audit` tool (FR-037): runs a stated focus through the same
  pipeline as reasoning steps (narrative stripping, deterministic
  invariants, side-session peer audit); whitespace-only or
  narrative-only focus is rejected without invoking the audit.
- On-demand audit delivery (FR-038): failed audits return the critique
  in the tool result only — no steer, no interrupt, no regeneration
  budget consumption; passed focus joins the verified trace.
- On-demand audit bound (FR-039): `maxOnDemandAudits` per session
  (default 8; `OPENCODE_SUPERVISOR_MAX_ON_DEMAND_AUDITS`); the
  automatic audit loop is unaffected.
- Console-tool hardening (FR-040, FR-041): side sessions get inert
  results; malformed arguments yield actionable results, never thrown
  errors.
- Trust boundary (FR-042): self-reported report text is recorded and
  surfaced only — it never enters peer-audit prompts.

### Changed

- Storage is decoupled from render (design D3): solved-items and
  critique-log storage is bounded by retention constants (50 solved
  items, 30 critiques) instead of the memo render caps, so recall
  reaches further than the memo shows; memo output is unchanged.
- `MemoLimits` gained a required `maxReports` field (default 5) —
  code constructing `MemoLimits` literals must add it.
- Documentation: README §9's directive-glob limitation was rewritten to
  match 2.2.0 behavior (root-anchored, case-insensitive globs; a
  broader best-effort extractor than the verified-trace check;
  `**/`-prefixed globs for deeper or differently anchored spellings) —
  the prior text claimed the same extension set as the trace check.

32 new tests (182 total) pass under Bun and Node 22+.

## [2.2.0] - 2026-10-25

Spec deltas:
`openspec/changes/engineer-directives/specs/engineer-directives/spec.md`.

### Added

- `engineer-directives` capability spec (FR-026..FR-032): the
  engineer console — the second console on the supervision plane.
- Directive sources (FR-026): `.opencode/supervisor/directives/*.md`
  files from the project directory (markdown advisory body plus a
  fenced `supervisor` JSON rules block) merged with
  `options.directives` passed through tuple plugin registration
  (`[path, options]`). Files load in sorted filename order; no
  sources means 2.1.0 behavior.
- Enforcement rules (FR-028): `forbidPath` globs and `forbidPattern`
  regexes block matching tool calls before execution through the
  tool guard (between the reward-hacking and trace checks). Block
  reasons name the directive id, the match, and the advisory text.
  An empty rule set never blocks.
- Trigger rules (FR-029): directives with `when` rules (tool name or
  argument-path glob) surface in the memo just-in-time after a
  matching tool call — blocked calls still trigger. Unconditioned
  directives ride the memo always.
- `Directives:` memo section (FR-030) rendered between the goal and
  the reminders, bounded by a fixed aggregate render budget.
- Auditor prompt extension (FR-031): the peer audit receives the
  directive advisory text and flags steps that violate it.
- Fixed bounds with fail-open loading (FR-032): 20 directives, 1000
  characters of advisory text per directive, 10 rules of each kind
  per directive, 4000-character aggregate render budget. Malformed
  files and invalid rules are skipped with a warning.

### Changed

- `server` now accepts the plugin options parameter
  (`server(input, options)`); registering via a tuple
  (`[path, options]`) passes `options.directives`.
- `verifyToolIntent` accepts an optional compiled-enforcement
  argument; `runPeerAudit` an optional directives-text argument —
  both optional, prior call sites unchanged.

40 new tests (137 total) pass under Bun and Node 22+.

## [2.1.0] - 2026-10-25

Spec deltas:
`openspec/changes/agent-reminders/specs/agent-reminders/spec.md`.

### Added

- `agent-reminders` capability spec (FR-020..FR-025): the agent
  console's first slice is now a spec'd requirement surface.
- `remind_me` / `forget_reminder` tools registered on the plugin hook
  map (`Hooks.tool`) — the primary agent can store durable reminders
  (dead ends, environment quirks, decisions, user constraints) and
  clear them by id. Tool descriptions are meta-prompts telling the
  agent when to use them; results echo the stored text, so a reminder
  survives gateway memo drops. Supervisor side sessions get inert
  results and never write state (FR-024).
- `Reminders:` section in the supervisor memo — reminders ride the
  memo each turn (surviving context compaction), most recent last,
  bounded by the new `memoLimits.maxReminders`.
- `OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS` (default 10) configuration
  knob, resolved session plugin config → environment → default
  (FR-023).
- Text hygiene on reminder storage: whitespace-only text is rejected
  with an actionable message; text over 2000 characters is truncated
  and the result says so (FR-025).
- 22 new tests in `test/reminders.test.ts` (module, memo integration,
  and tool layer); the full suite passes 97 under Bun and Node.

### Changed

- `MemoLimits` (exported from `src/memo.ts`) gains a required
  `maxReminders` field — a typed-surface change for direct consumers
  of the module API (the plugin's own call sites were updated in this
  change; `MemoInput.reminders` stays optional).

## [2.0.0] - 2026-10-25

Spec deltas: `openspec/changes/rebrand-supervisor/specs/supervisor-config/spec.md`.

### Added

- `supervisor-config` capability spec: the plugin identity and
  configuration surface (id, version, `OPENCODE_SUPERVISOR_*`
  variables, clean-break migration contract) are now spec'd
  requirements (FR-018, FR-019).

### Changed

- **BREAKING**: renamed the plugin from `opencode-reasoning-audit`
  to `opencode-supervisor` — plugin id, session config key, package
  name, and GitHub repository (old URLs redirect). The project is
  growing from a reasoning auditor into a supervision plane (agent
  self-serve tools and engineer directives on the roadmap); the
  rename lands before those surfaces so nothing ships under the old
  name.
- **BREAKING**: renamed every configuration environment variable
  from the `OPENCODE_AUDITOR_` prefix to `OPENCODE_SUPERVISOR_` —
  see the migration table in README Section 6.2:
  `OPENCODE_AUDITOR_MODEL` → `OPENCODE_SUPERVISOR_MODEL`,
  `OPENCODE_AUDITOR_VARIANT` → `OPENCODE_SUPERVISOR_VARIANT`,
  `OPENCODE_AUDITOR_MAX_REGENERATIONS` →
  `OPENCODE_SUPERVISOR_MAX_REGENERATIONS`,
  `OPENCODE_AUDITOR_STRIP_MODE` → `OPENCODE_SUPERVISOR_STRIP_MODE`,
  `OPENCODE_AUDITOR_BLOCK_REWARD_HACKING` →
  `OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING`,
  `OPENCODE_AUDITOR_REQUIRE_STEP_REFERENCE_IN_TOOLS` →
  `OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS`,
  `OPENCODE_AUDITOR_MEMO_MAX_SOLVED_ITEMS` →
  `OPENCODE_SUPERVISOR_MEMO_MAX_SOLVED_ITEMS`,
  `OPENCODE_AUDITOR_MEMO_MAX_CRITIQUES` →
  `OPENCODE_SUPERVISOR_MEMO_MAX_CRITIQUES`. 1.x names are not read
  as aliases.
- User-visible message prefix `[reasoning-audit]` → `[supervisor]`;
  the auditor side session is titled `supervisor-audit @ …`.
- README rewritten around the supervision identity with a migration
  table; no behavior changed — test assertions updated only for
  renamed identifiers (task 1.3); all 75 pass under Bun and Node.

## [1.0.0] - 2026-10-25

Spec deltas: `openspec/changes/audit-supervisor/specs/reasoning-audit/spec.md`,
`openspec/changes/audit-supervisor/specs/tool-guard/spec.md`,
`openspec/changes/audit-supervisor/specs/supervisor-memo/spec.md`.

### Added

- Rebuilt the plugin onto the real `@opencode-ai/plugin` Hooks API
  (`event`, `chat.message`, `tool.execute.before`,
  `tool.execute.after`, `experimental.chat.system.transform`) — the
  plugin now actually loads; the previous entry targeted nonexistent
  OpenCode APIs and never registered.
- Reasoning audit with critique delivery: a failed audit steers the
  session with a corrective prompt; severe findings interrupt the
  session first. The whole intervention — the severe interrupt and
  every delivered critique — is bounded by `maxRegenerations` per
  session.
- Tool guard with actionable blocks: reward-hacking tool calls are
  blocked before execution with a reason the model can act on; file
  paths absent from the verified reasoning trace are blocked, and an
  empty trace never blocks.
- Supervisor memo: the session goal, recently solved items, and recent
  critiques are appended to the system prompt before each model call.
- Severity classification (`minor` | `severe`) on audit outcomes, with
  the session goal passed to the audit prompt for scope-drift findings.
- Configuration knobs for the new behavior — `maxRegenerations`,
  `stripMode`, `blockRewardHacking`, `requireStepReferenceInTools`,
  and `memoLimits` — resolved session plugin config → environment →
  defaults.

### Changed

- Peer audits run in a dedicated auditor side session driven by the
  OpenCode client (`session.prompt`); audit traffic never enters the
  supervised conversation, and auditor errors fail open.
- Registration and configuration documentation corrected to the real
  mechanisms (the OpenCode `plugin` config array, the
  `opencode plugin` command, and the `OPENCODE_AUDITOR_*` variables);
  the previously documented install command never existed in any
  published version of its tool.

### Removed

- **BREAKING**: `OPENCODE_AUDITOR_ENDPOINT` — the HTTP auditor
  fallback no longer exists; audits run only through the auditor side
  session.
- **BREAKING**: the middleware surface built on the nonexistent
  `onMessageUpdated` / `onToolExecute` lifecycle hooks, including the
  `session.injectMessage` / `session.regenerate` repair loop —
  replaced by the Hooks API surface above.
- The orphaned `injectRole` configuration knob. It was declared on
  `AuditConfig`, defaulted in `pluginConfig`, and carried through the
  fixtures, but no code ever read it — removing it changes no
  behavior.
