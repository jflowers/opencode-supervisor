# Proposal

## Why

One field session (ses_e72a74b18ffeOU3uNACKZ9k1Jz, adlc-research,
2026-10-30 into 10-31, plugin v2.5.0, default config) produced four
sibling defects (#35, #36, #33, #34) in the verified-trace check
pipeline — the guard that blocks tool calls whose file arguments
never appeared in audited reasoning. Every `[supervisor] audit
finding` delivered in that session was a false positive: correct
chained sums misread as their final two operands. The trace check
then fenced honest documentation work (filenames quoted inside
authored content), was silently bypassed through wildcard
spellings the tokenizer cannot see, and raced its own audit
pipeline (block on first attempt, pass on immediate retry). A
supervision layer that cries wolf trains the model to disregard
its findings — including the true ones — and this session ended
with the agent routing around the gate and writing folk rules
about it into its own notes.

The four defects interlock in one pipeline: the arithmetic
invariant and the stripper determine what the trace CONTAINS, the
argument lens determines WHICH tool arguments are scanned, the
tokenizer determines HOW they are matched, and the audit
coordination determines WHEN the trace is read. They are repaired
as one change.

## What Changes

- Fixed (#35): the arithmetic invariant evaluates full chained
  expressions with standard operator precedence — `38+16+2=56`
  passes, `2+3*4=14` passes, `2+3*4=20` fails — instead of
  reading the expression's final two operands; the critique
  quotes the full matched expression verbatim so a flagged
  fragment is self-describing.
- Changed (#35, #34): a minor deterministic invariant failure
  (arithmetic, off-by-one) delivers its bounded critique but no
  longer evicts the whole reasoning part from the verified trace;
  severe findings (reward hacking) and peer-audit failures still
  evict. A misstated tally no longer vanishes every path mention
  in the same part.
- Fixed (#36): the path tokenizer gains a trailing boundary
  (`.js` no longer matches inside `.json`) and treats
  wildcard-bearing and `$var`-bearing operational tokens as
  patterns matched by glob semantics against trace-referenced
  paths. `kb/topics/*.md` can no longer slip past the gate
  unexamined, and `"$bdir/$id.md"` no longer demands a phantom
  `id.md` from the trace.
- Fixed (#33): the trace check scans operational arguments only.
  For non-bash tools, values under the content keys (`content`,
  `oldString`, `newString`) are authored data, not targets — the
  review-round-4 protected-state lens applied to its sibling
  check. The plugin's registered console tools are exempt from
  the trace check, mirroring the gate exemption, so
  `request_audit`'s own focus text cannot fence the supervision
  channel it exists to keep open.
- Fixed (#34): the tool guard coordinates with in-flight audits.
  When a call would block on the trace check and audits are still
  settling, the guard waits a bounded time (10 seconds) and
  re-checks before blocking; on timeout it fails open and logs
  (FR-005 posture). Path-bearing prose survives narrative
  stripping in `code_and_math` and `balanced` modes, so the
  corrective instruction ("reason about the file in verified
  steps, then retry") is followable under the default config.
- Changed: version 2.5.1 (repair release).

## Capabilities

### New Capabilities

- `trace-check`: the verified-trace check pipeline end-to-end —
  what the trace contains (arithmetic chain evaluation, the unit
  of failure, stripper survival for path-bearing steps), which
  tool arguments the check scans, how those arguments are
  tokenized and matched, and when the check reads the trace
  (FR-062..FR-068).

### Modified Capabilities

- `tool-guard` (FR-010..FR-012, pending in the `audit-supervisor`
  change): the trace check's detection scope is refined — content
  keys and the plugin's console tools leave the scanned set,
  wildcard and `$var` spellings enter it as glob patterns, and
  the check reads the trace only after in-flight audits settle
  or time out. FR-011 (empty trace never blocks) is preserved
  verbatim. The refined requirements are carried in the new
  `trace-check` delta, self-contained, following the
  fix-supervisor-logging and agent-reminders precedent — a
  MODIFIED delta would target a main spec that does not exist
  until `audit-supervisor` archives.
- `reasoning-audit` (FR-002, FR-003, FR-006, pending in the
  `audit-supervisor` change): the arithmetic invariant evaluates
  full chains, minor deterministic failures no longer evict
  steps from the verified trace, and path-bearing steps survive
  stripping in `code_and_math`/`balanced`. Carried in the
  `trace-check` delta for the same reason.

## Impact

- **Code**: `src/auditor.ts` (chain evaluation with precedence,
  verbatim critiques, an outcome source field distinguishing
  deterministic from peer failures); new `src/path-tokens.ts`
  leaf module (the shared path-token grammar: extraction,
  trailing boundary, pattern classification — imported by the
  guard and the stripper so "reason about X" and "check X" agree
  on what X is); `src/tool-guard.ts` (content-key lens,
  console-tool exemption parameter, glob and `$var` pattern
  matching); `src/stripper.ts` (path-token survival);
  `index.ts` (in-flight audit tracking, await-on-miss guard
  coordination, no-evict recording, console-tool set wiring);
  `package.json` and `PLUGIN_VERSION` (2.5.1).
- **Tests**: `test/audit.test.ts` carries the regression
  material (chained sums, glob and `$var` tokens, content-key
  lens, console-tool exemption, delayed-audit race); existing
  fixtures asserting whole-part eviction on arithmetic failures
  update to the no-evict contract.
- **Docs**: `README.md` (§4.2 the tool guard, §7.1 stripMode,
  §9 limitations), `CHANGELOG.md` (2.5.1), `AGENTS.md`
  (architecture bullets for the trace pipeline).
- **Users**: default-config sessions stop receiving misquoted
  arithmetic findings; writes whose content quotes filenames, and
  calls like `request_audit` that name one in passing, stop
  fencing; wildcard batches regain a verdict instead of a silent
  bypass; same-turn tool calls stop block-then-retry racing. The
  guard keeps its teeth: a concrete operational path absent from
  settled, verified reasoning still blocks.
- **Out of scope**: reward-hacking markers inside console-tool
  payloads (FR-009 stays unconditional), heredoc-aware bash
  parsing, shell-variable resolution, memo critique re-delivery
  (follows automatically once findings are accurate), and a
  config knob for the await bound.
