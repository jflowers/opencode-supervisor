# Design

## Context

See `proposal.md` — Why for the field session and the four
issues (#35, #36, #33, #34). The mechanics, briefly:

- `checkDeterministicInvariants` (src/auditor.ts:111) matches
  one binary pair per equation, so `38+16+2=56` is checked as
  `16+2=56`; a failed invariant drops the whole part from
  `state.verifiedSteps` (index.ts:1457-1463).
- `FILE_PATH_PATTERN` (src/tool-guard.ts:52) omits `*` and `$`
  and has no trailing boundary: `kb/topics/*.md` tokenizes to
  nothing, `"$bdir/$id.md"` yields the phantom `id.md`, and
  `.js` matches inside `.json`.
- `extractArgPaths` (src/tool-guard.ts:62) scans every
  top-level string value, so authored `content` quoting a
  filename blocks as an unaudited touch; the plugin's console
  tools are exempt from gates (index.ts:1584-1587) but not from
  `verifyToolIntent`.
- The `event` hook audits fire-and-forget; `runPeerAudit`
  awaits a side-session LLM call before the step is pushed to
  the trace, while `tool.execute.before` reads the trace
  synchronously — same-turn reasoning is routinely absent at
  guard time. Under the default `stripMode: 'code_and_math'`,
  prose path mentions without ticks or operator characters are
  dropped before audit (src/stripper.ts; the `hasFormalSpec`
  keyword branch applies only in `balanced`).

Two in-repo precedents constrain the fixes. Review round 4 gave
`checkProtectedState` a content-key lens (CONTENT_ARG_KEYS =
`content`, `oldString`, `newString`; every other key scanned so
custom/MCP names stay covered — fail closed). Review round 5
gave it glob-semantics segment matching (`segmentMatches`,
`globSegmentToRegExp`) because the shell expands wildcards at
execution time. Both live in src/tool-guard.ts and are reused,
not reinvented.

## Goals / Non-Goals

**Goals:**

- The trace check reads as one pipeline end to end: trace
  contents (#35, #34), scanned arguments (#33), tokenization
  (#36), read timing (#34) — one coherent contract (the
  `trace-check` capability, FR-062..FR-068).
- Zero false-positive audit findings on correct chained sums;
  the guard keeps its teeth on genuinely unreferenced paths.
- The corrective instruction ("reason about the file in
  verified steps, then retry") is followable under the default
  config, deterministically, on the first retry.
- Every decision the issues left open is decided here with
  recorded rationale and the safer option where an issue gave a
  safety tiebreaker.

**Non-Goals:**

- Reward-hacking markers inside console-tool payloads or
  authored content (FR-009 scans raw arguments; unchanged).
- Heredoc-aware bash parsing and shell-variable resolution
  (documented residuals).
- Extending the await coordination to review gates (the
  `directive-gates` change's review-gate trace requirement);
  they keep their current semantics.
- A config knob for the await bound (a constant; join the
  config chain only if field evidence demands).
- Replacing the extension allowlist with a broader path
  grammar (the FR-010 detection boundary stays as specified;
  see D3).

## Decisions

### D1: Full-chain arithmetic evaluation (issue #35)

The invariant evaluates the complete expression — every operand
and operator up to the stated total — with standard precedence
(multiplication/division before addition/subtraction,
left-associative within a tier), a leading/trailing digit
boundary on the span, the existing 1e-6 tolerance, and
division-by-zero declining to judge (the current code already
passes `a/0`; chains keep that fail-open posture).

Rejected: decline-to-judge on continuation. It is gameable —
an incorrect `3+2=56` becomes `9+3+2=56` and sails past a
checker that declines chains — and it blinds the invariant on
the most common tally shape: every field finding was a chain.
The issue's own tiebreaker ("if gameable, full-chain evaluation
is safer") decides this. Unary minus stays out of scope (the
current regex never matched leading signs); a leading `-`
simply starts the span at the first operand, as today.

Critique text quotes the full matched expression verbatim
("stated 38+16+2=57, evaluates to 56"), so a flagged claim is
self-describing and the memo cannot re-deliver a misquote.

### D2: Minor deterministic failures critique without eviction
(issues #35 and #34, shared)

The unit of failure is decided explicitly: an arithmetic or
off-by-one invariant failure delivers its bounded critique
(FR-007) but the step still enters the verified trace; severe
deterministic findings (reward hacking) and peer-audit failures
evict the whole step, as before.

Rationale: the trace is a path-reference ledger — its
path-ledger consumer (FR-010) asks "was this path reasoned
about?", not "was every arithmetic claim correct?" Its
passed-only consumers (the directive-gates review gate;
`request_audit`, FR-037) keep their semantics through the
outcome tag, not by loosening. A misstated tally does not
revoke the part's file reasoning, and the field cascade
(misquote → vanished paths → blocked writes → folk rules →
wildcard bypass) came exactly from that coupling.

Rejected: claim-level extraction (dropping only the failed
sentence). Sentence segmentation is fragile, and the remainder
was never audited as a unit — it would need a re-audit loop.
Rejected: recording extracted path tokens from dropped steps
un-audited. That opens a spray surface: one prose part
mentioning every intended target would pre-populate the trace
immune to audit. Keeping the whole step audited preserves the
audit-before-reference property (FR-001) while severing the
coupling.

Mechanics: `PeerAuditOutcome` gains `source?: 'invariants' |
'peer'`, set by `checkDeterministicInvariants` and the
peer-audit path respectively. A small pure predicate
(`outcomeRecordsStep`: passed, or invariants-source and not
severe) is exported from src/auditor.ts and governs the
event hook's recording. Recorded steps carry their outcome:
`verifiedSteps` holds `VerifiedTraceEntry` values
(`{ text, passed }`). The FR-010 path ledger consumes entry
text regardless of outcome; `evaluateReviewGates` filters to
passed entries for gate release; and the `request_audit` body
stays passed-only (FR-037) — a failed focus never appends,
whatever its source.

### D3: One shared path-token grammar in a leaf module
(issues #36 and #34)

A new leaf module `src/path-tokens.ts` owns the grammar: the
token pattern (path characters plus `*`, `?`, `[`, `$`, with a
trailing boundary so an extension match must end at a
non-path character), `extractPathTokens(text)`,
`hasPathToken(text)`, and `isPatternToken(token)`. The guard
and the stripper both import it, so "reason about X" and "the
guard checks X" recognize the same X — the corrective loop
closes by construction.

Why a leaf module rather than stripper importing tool-guard:
the convention pack's no-cycles rule (AP-006) and the
module-structure learning both prescribe shared leaf modules
over cross-imports; the grammar is shared vocabulary, not guard
logic. The extension allowlist itself is unchanged — its
boundary is a requirement-scope decision already documented in
the spec-accuracy learning, and widening it is not part of
these four repairs.

### D4: Glob semantics for wildcard tokens, with a trailing
boundary (issue #36)

An operational token bearing glob metacharacters is a pattern:
the call passes when the trace references a path satisfying the
pattern or contains the pattern verbatim; otherwise it blocks
with a reason naming the pattern and the corrective action.
Matching reuses round 5's `globSegmentToRegExp` (already in
src/tool-guard.ts): compile the pattern token segment-wise and
test it against path tokens extracted from the trace text
(`extractPathTokens` over each verified step). The trailing
boundary (D3) makes `config.json` tokenize whole — the
extension alternation already backtracks to the longer
`json` — and kills the `.js`-inside-`.json` prefix matches.

Rejected: fail closed on wildcard-bearing arguments. The field
session shows what that produces — agents restructure
legitimate globs into runtime path derivation (`basename`,
loop variables), which is strictly harder to audit than the
glob it replaced. Round 5 made the same call for the
protected-state check.

### D5: `$var` segments are runtime-unknown patterns
(issue #36)

Threat model, decided: `"$bdir/$id.md"` is an audited pattern,
not an unaudited touch — the loop it rides in is the reasoning
unit. A `$name` span translates to a within-segment wildcard
(`*`) before glob compilation, so the token never demands the
phantom `id.md`; it is satisfied by a verbatim pattern mention
in passed reasoning (the self-consistency path: the model
reasoned in the same spelling) or by a trace path matching the
resulting pattern.

Rejected: cross-segment `**` for variables — `$bdir` can hold
a multi-segment path, but `**` would let any `.md` mention
satisfy any `$var/*.md` call, dissolving the filename-level
check. Rejected: shell-variable resolution — unsound and a
rabbit hole. Residual: a variable spelling whose literal
segments are unconstrained (`"$a/$b"`) reduces to a
structural check only; accepted, and the block reason names
the pattern so the corrective path is explicit.

### D6: The trace check adopts the round-4 content-key lens
(issue #33)

Re-read of the round-4 rationale (src/tool-guard.ts:266-276):
mentions inside authored data are not touches, unknown and
custom key names stay covered, coverage fails closed — an
operational-key allowlist had let a custom tool touch the
approvals file unblocked. The trace check gets the same lens,
using the same idiom `checkProtectedState` already uses
(filter `Object.entries` minus CONTENT_ARG_KEYS, non-bash
only); bash command strings remain operational in full,
mirroring the raw lens and its 64 KiB cap posture.

The key set does NOT grow per tool: `focus` and `text` do not
join CONTENT_ARG_KEYS. The except-list is per-key and
universal — adding per-tool payload keys would open custom-tool
evasion (a tool whose operational arg happened to be named
`focus`). The plugin's own channels are handled structurally
by D7 instead. Residual, carried forward from round 5's
protected-state posture: payload keys beyond the content
blocklist (`text`, `body`, `document`, `patch`, `diff`,
`edits`, `data`) are still scanned for non-bash tools and can
false-positive — fail closed, accepted as the same residual
class.

### D7: Console tools are exempt from the trace check
(issue #33)

The plugin's registered console tools skip the file-path trace
check, mirroring the gate exemption (index.ts:1584-1587) and
derived the same way — from the registered tool map, so a
future console tool is covered automatically. The
review-gate corrective instruction points at `request_audit`;
blocking that call on its own `focus` text fences the channel
that exists to keep the loop open.

Mechanics: `verifyToolIntent` gains an optional
`consoleTools?: ReadonlySet<string>` parameter (default none —
fail-closed for direct callers; existing four-argument callers
are unaffected). index.ts passes the set derived from
`hooks.tool`. The reward-hacking check still applies: FR-009
is unconditional and the field session showed no such block;
narrowing it is out of scope (Non-Goals).

### D8: Await-on-miss with a bounded timeout (issue #34)

Coordination is decided over the weaker "honest block reason"
option: a gate that lies by omission stays in the loop and
keeps training folk rules. Mechanics:

- `SessionState` gains `pendingAudits: Set<Promise<unknown>>`.
  The event hook registers its audit continuation (dedupe →
  strip → audit → trace mutation / critique delivery) and
  deregisters it in a finally; the registered promise resolves
  only after the trace mutation, so an awaiter always re-reads
  a settled state.
- `tool.execute.before` runs the guard as today. Block-cause
  attribution is structured, never prose-matched:
  `ToolVerificationResult` gains
  `blockedCheck?: 'reward-hacking' | 'directives' | 'trace'`,
  set on every blocked return (the `PeerAuditOutcome.source`
  idiom, so FR-012 reasons stay free-form corrective signals).
  Only when the verdict is blocked AND `blockedCheck ===
  'trace'` AND `pendingAudits` is non-empty does it await
  `Promise.race([Promise.allSettled(pending), timeout])` —
  the timer cleared on every path, per the round-3
  derived-lookup precedent — then re-runs verification against
  the live `verifiedSteps` array and acts on the fresh
  verdict. A rejected continuation counts as settled:
  `allSettled` never rethrows into the hook; the rejection is
  logged once and the re-check runs against the live trace.
  Reward-hacking and directive blocks never charge the wait;
  the fast path (call passes, or no audits in flight) pays
  nothing; audit storms pay one bounded wait regardless of
  pending count.

Bound: 10 seconds, a named constant — a small-model
side-session round trip is seconds; the derived-lookup
precedent budgets 5 s for a cheap GET, and an LLM call needs
more. On timeout the call is allowed and one warning is
logged: FR-005's posture toward supervision uncertainty, and
the FR-011 branch's own comment already names "audit still in
flight" as a not-yet-trace state. The fail-open is capped per
session (`maxTimeoutFailOpens`, default 3, resolved through
the precedence chain in index.ts — the maxRegenerations/
maxOnDemandAudits bounding idiom): an agent that keeps audits
in flight cannot convert the timeout into an on-demand
bypass. Below the cap a timeout allows and logs; at the cap a
timed-out wait blocks with the honest reason naming the
still-unsettled audit. Every timeout is logged either way.
Teeth are preserved — a path absent from settled, verified
reasoning still blocks, and the empty-trace allow (FR-011) is
untouched: no reasoning at all means no wait and no block.

The bound is exported as mutable state
(`traceAwaitState = { timeoutMs: 10_000 }`, the
`logIdentityState` precedent) so the timeout test runs in
milliseconds, not ten seconds. `request_audit`'s own audit is
awaited inside the tool body (its result is the channel), so
it never joins the pending set.

### D9: Path-bearing steps survive stripping (issue #34)

In `code_and_math` and `balanced`, the survival disjunction
gains `hasPathToken(step)` (D3's grammar): a step mentioning
`notes.md` in plain prose survives stripping — narrative-prefix
removal still applies — reaches the audit, and on passing
enters the trace. `strict` is unchanged: zero natural language
is its contract.

Rejected: extract-and-reattach (record path tokens from
dropped steps without the prose). It feeds the trace un-audited
entries — the spray surface D2 rejects — and downgrades FR-006
from audit-before-reference to mention-anywhere. Rejected:
documentation-only (recommend `balanced`) — it leaves the
default config's corrective loop broken, and the field session
ran defaults.

Residual, accepted deliberately: persuasive narrative can ride
a path-bearing sentence into the audit prompt and the trace
(the stripper's purpose is narrowed for those steps). The
auditor still sees the full step and can fail it — a path
spray unrelated to the goal is drift-flaggable — and the
guard's trace matching is inert to prose. Under the
no-auditor-model default install (FR-060) the filtering
tier is deterministic only — arithmetic, off-by-one, and
reward-hacking markers — so the widened survival is filtered
by those alone until an auditor model is configured. Chosen
over the alternatives because it keeps every trace entry
audit-passed.

### D10: Capability organization and FR numbering

The refined requirements land in one new capability,
`specs/trace-check/spec.md` (FR-062..FR-068), presenting the
pipeline as one repair. No prior change in this repo uses a
MODIFIED delta, and the capabilities being refined
(`tool-guard`, `reasoning-audit`) exist only inside the
unarchived `audit-supervisor` change — a MODIFIED delta would
target main specs that do not exist yet. The
fix-supervisor-logging precedent (new, self-contained
capability deltas; the conceptually-modified capability named
in the proposal) is followed exactly.

FR numbering continues from FR-062: the highest number across
the openspec tree is FR-061 (fix-supervisor-logging, pending
archive); `openspec/specs/` shows FR-042 only because five
changes await archive, and starting lower would collide with
their allocations when they sync.

Archive reconciliation: when `audit-supervisor` archives, the
reasoning-audit main spec lands carrying FR-001's exclusion (an
unaudited step MUST NOT be treated as part of the verified
trace) and FR-006's pass-only recording. The archive step MUST
reconcile those with FR-063 at sync time — the membership rule
becomes "audited steps enter the ledger carrying their
outcome; severe findings and peer failures evict" — amending
the main requirement text rather than leaving it
contradicting `trace-check`. Two siblings reconcile the same
way: the `directive-gates` review-gate trace requirement
releases on a passed step, preserved by `evaluateReviewGates`
filtering outcome-carrying entries — its main-spec text names
the passed-step filter at sync; and supervisor-tools FR-037
(already a main spec) needs no amendment, because
`request_audit` recording stays passed-only by construction.

### D11: Version 2.6.0 (MINOR)

A MINOR release, not a PATCH: the proposal classifies the
no-evict trace-semantics change as Changed — the verified
trace deliberately gains minor-failed steps, a behavior-
contract change rather than a defect repair — and every
Changed-bearing release in the changelog shipped MINOR (2.5.0
shipped FR-061's new blocking behavior the same way; the file
holds no PATCH release). The constitution's MAJOR clause is
not triggered: no analysis behavior breaks. Both
`PLUGIN_VERSION` (index.ts) and `package.json` move together —
the lockstep test enforces it.

## Risks / Trade-offs

- [Persuasion rides path-bearing prose into audit and trace]
  → The auditor still sees and can fail the step (whole-part
  eviction on peer failure); the trace consumer is inert to
  prose. Accepted over un-audited trace entries (D9).
- [Bash heredoc bodies are scanned as operational] → A bash
  call quoting filenames inside a heredoc can trace-block.
  Documented residual, mirroring the protected-state check's
  identical posture; heredoc parsing is a Non-Goal.
- [Payload keys beyond the content blocklist false-positive]
  → Custom tools with `text`/`body`/`document` keys quoting
  filenames can trace-block. Fail-closed residual carried from
  round 5; same class as the protected-state check.
- [Console-name collisions inherit the trace-check exemption]
  → A foreign tool (an MCP server or custom plugin)
  registered under a colliding console name — `report` and
  `recall` are generic — inherits FR-065's exemption. The
  reward-hacking, directive, and protected-state checks
  still apply to it. Accepted with the name-keyed trust the
  gate exemption already extends.
- [Timeout fail-open passes an unreferenced path] → Bounded to
  the rare unsettled-audit window, capped per session, logged,
  and symmetric with FR-005's treatment of auditor failures.
  Teeth hold on settled traces (FR-067 scenario).
- [Would-block calls gain up to 10 s latency] → Only calls
  that would block AND have audits in flight; passing calls
  and settled traces pay nothing. The alternative race is the
  defect being repaired.
- [No-evict records steps with known-bad claims] → The trace
  is a reference ledger (D2); the critique still fires and is
  bounded by maxRegenerations; severe and peer failures still
  evict.
- [More steps survive stripping → more audit side sessions]
  → Volume grows with path-mentioning prose, bounded by part
  count; each audit remains a fresh side session (FR-001) and
  the fail-open path is unchanged.
- [Existing fixtures assert whole-part eviction on arithmetic
  failures] → They update to the no-evict contract in the same
  task as the behavior change; the FR-011 and FR-010 positive
  fixtures must stay green throughout.

## Migration Plan

Version bump only (2.6.0); no configuration, storage, or
interface migrations — session state is in-process and the new
`pendingAudits` field dies with it. Rollback is reverting the
release; no persisted state depends on the new behavior.
