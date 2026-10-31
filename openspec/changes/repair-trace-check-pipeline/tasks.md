# Tasks

## 1. Spec artifacts

- [x] 1.1 [P] Write `proposal.md`,
  `specs/trace-check/spec.md` (FR-062..FR-068), `design.md`,
  and this `tasks.md`. Verify: `openspec validate
  repair-trace-check-pipeline` passes; every scenario carries
  GIVEN/WHEN/THEN; RFC 2119 wording; lines under 72.

## 2. Arithmetic invariant (#35 — FR-062, FR-063)

- [ ] 2.1 Replace the binary-pair equation regex in
  `checkDeterministicInvariants` (src/auditor.ts) with a
  full-chain matcher: the complete operand/operator span and
  the stated total, digit-boundaried at both ends, evaluated
  with standard precedence (`*`/`/` before `+`/`-`,
  left-associative), keeping the 1e-6 tolerance and declining
  to judge division by zero (FR-062, design D1). Verify: the
  matcher is pure and local to src/auditor.ts; no model call
  precedes it.
- [ ] 2.2 Quote the full matched expression verbatim in the
  arithmetic critique (FR-062). Verify: a failing chain's
  critique contains the whole stated expression, not a
  fragment.
- [ ] 2.3 Add `source: 'invariants' | 'peer'` to
  `PeerAuditOutcome` (set by `checkDeterministicInvariants`
  and by the peer-audit path) and export the pure predicate
  `outcomeRecordsStep(outcome)` — passed, or invariants-source
  and not severe (FR-063, design D2). Verify: the predicate is
  pure and both failure sources are distinguishable in the
  outcome.
- [ ] 2.4 Apply no-evict recording in index.ts: the event hook
  and the `request_audit` body record the step whenever
  `outcomeRecordsStep` says so, delivering the critique as
  before when the audit failed (FR-063). Verify: a mis-sum
  step both delivers its critique and remains in
  `state.verifiedSteps`; severe and peer failures still evict.
- [ ] 2.5 Tests (test/audit.test.ts): the field regression
  strings — `38+16+2=56`, `1+1+3+2+2+2+9 = 20`,
  `456+139+62=657`, `133+3+521=657`, `31+3+623=657` pass;
  `16 + 2 = 56` and `2 * 3 = 8` fail; `2+3*4=14` passes and
  `2+3*4=20` fails; the critique quotes the whole expression;
  hook-layer no-evict (critique delivered, step recorded) with
  severe and peer eviction intact. Update existing fixtures
  that assert whole-part eviction on arithmetic failure
  (FR-062, FR-063). Verify: `bun test` and
  `node --test test/audit.test.ts` green.
- [ ] 2.6 Docs: CHANGELOG `[Unreleased]` Fixed bullet for the
  chained-sum repair; README §4.1 note that chained sums
  evaluate whole and that minor deterministic failures
  critique without losing the step; AGENTS.md audit-pipeline
  bullet. Verify: no stale claim that one bad sentence drops
  the whole step.

## 3. Path tokenizer (#36 — FR-066)

- [ ] 3.1 Create `src/path-tokens.ts` as a pure leaf module
  owning the shared grammar: the token pattern (path characters
  plus `*`, `?`, `[`, `$`, with a trailing boundary so an
  extension match ends at a non-path character),
  `extractPathTokens`, `hasPathToken`, and `isPatternToken`
  (design D3). Verify: the module imports nothing;
  `config.json` tokenizes whole (no `.js` prefix token);
  `kb/topics/*.md` yields one pattern token.
- [ ] 3.2 Rebase `extractArgPaths` (src/tool-guard.ts) on the
  shared grammar (FR-066). Verify: existing tool-guard tests
  stay green; extraction of non-pattern tokens is unchanged.
- [ ] 3.3 Teach `findUnreferencedPath` pattern semantics:
  translate `$name` spans to within-segment wildcards, compile
  pattern tokens with `globSegmentToRegExp`, and satisfy a
  pattern when the trace contains it verbatim or any
  trace-extracted path token matches the glob; non-pattern
  tokens keep full-path/basename matching (FR-066, design
  D4/D5). Verify: block reasons name patterns, never phantom
  tokens like `id.md`.
- [ ] 3.4 Tests (test/audit.test.ts): `kb/topics/*.md` passes
  with a `kb/topics/gov-ci.md` trace reference and blocks
  naming the pattern without one; `"$bdir/$id.md"` never
  demands `id.md` and passes on a verbatim pattern mention;
  `config.json` does not tokenize as `config.js`; the FR-011
  empty-trace allow and the FR-010 concrete positive block are
  unchanged (FR-066). Verify: `bun test` and
  `node --test test/audit.test.ts` green.
- [ ] 3.5 Docs: CHANGELOG Fixed bullet for the tokenizer;
  README §4.2 pattern-token behavior; AGENTS.md tool-guard
  bullet. Verify: README no longer implies wildcard spellings
  pass silently.

## 4. Argument lens and console exemption (#33 — FR-064,
FR-065)

- [ ] 4.1 Give the trace check the round-4 content-key lens in
  `verifyToolIntent`: for non-bash tools, scan top-level string
  values minus CONTENT_ARG_KEYS (the `checkProtectedState`
  idiom); bash command strings stay operational in full
  (FR-064, design D6). Verify: a write whose `content` quotes
  an unreferenced filename no longer trace-blocks while its
  `filePath` is checked as before.
- [ ] 4.2 Add the optional `consoleTools?: ReadonlySet<string>`
  parameter to `verifyToolIntent` (default none) skipping the
  file-path trace check for registered console tools, and pass
  the set derived from `hooks.tool` in index.ts, mirroring the
  gate exemption (FR-065, design D7). Verify: `request_audit`
  with a focus naming an unreferenced path is not
  trace-blocked; the reward-hacking check still applies;
  existing four-argument callers are unaffected.
- [ ] 4.3 Tests (test/audit.test.ts): content-key tokens never
  trigger the trace check for non-bash tools (a `write` whose
  `content` quotes `risk-tier1.sh` with a referenced
  `filePath`); custom keys like `target` still block; bash
  command text still blocks; console tools never
  trace-blocked; the FR-010 positive case and FR-011 unchanged
  (FR-064, FR-065). Verify: `bun test` and
  `node --test test/audit.test.ts` green.
- [ ] 4.4 Docs: CHANGELOG Fixed bullet; README §4.2
  content-versus-operational lens and console-tool exemption;
  AGENTS.md tool-guard bullet. Verify: README names the bash
  heredoc residual.

## 5. Audit coordination and stripper (#34 — FR-067, FR-068)

- [ ] 5.1 Track in-flight audits: `SessionState` gains
  `pendingAudits` (a Set of promises resolving only after the
  trace mutation), registered and deregistered by the event
  hook's audit continuation (FR-067, design D8). Verify:
  `emptySessionState` and `clearAll` cover the new field; a
  registered promise settles only after `verifiedSteps` is
  updated.
- [ ] 5.2 Implement await-on-miss in `tool.execute.before`:
  when the trace check would block and `pendingAudits` is
  non-empty, await `Promise.race([Promise.all(pending),
  timeout])` with the timer cleared on every path, re-run
  verification, and on timeout allow the call and log one
  warning; export `traceAwaitState = { timeoutMs: 10_000 }`
  for test injection (FR-067, design D8). Verify: passing
  calls and settled traces take no wait; the FR-011
  empty-trace branch imposes no wait.
- [ ] 5.3 [P] Stripper survival: add `hasPathToken(step)` to
  the `code_and_math` and `balanced` survival disjunctions in
  src/stripper.ts; `strict` unchanged; narrative-prefix
  removal still applies (FR-068, design D9). Verify: prose
  mentioning `notes.md` survives in `code_and_math` and
  `balanced` and drops in `strict`.
- [ ] 5.4 Tests (test/audit.test.ts): the delayed-audit race —
  a reasoning part naming path P with a slow audit and a
  same-turn tool call on P passes once the audit lands within
  the bound, with no first-attempt block; timeout fail-open
  with `traceAwaitState.timeoutMs` overridden small (call
  allowed, one warning logged); settled-trace teeth (an absent
  path still blocks); empty-trace unchanged; the stripper mode
  matrix (FR-067, FR-068). Verify: `bun test` and
  `node --test test/audit.test.ts` green.
- [ ] 5.5 Docs: CHANGELOG Fixed bullets for the race and the
  stripper; README §4.1 (audit-to-guard coordination), §4.2
  (bounded wait), §7.1 (path-bearing survival), §9 residuals
  (persuasion riding path-bearing prose, timeout fail-open);
  AGENTS.md audit-pipeline and stripper bullets. Verify: README
  documents the 10-second bound and the fail-open behavior.

## 6. Integration and release

- [ ] 6.1 Run both suites end to end: `bun test` and
  `node --test` across all eight test files (no new test
  files, so the AGENTS.md node list is unchanged). Verify:
  both runtimes green.
- [ ] 6.2 Stamp 2.5.1: `package.json` and `PLUGIN_VERSION`
  together; the CHANGELOG `[Unreleased]` section becomes
  `[2.5.1]` with the release date and references to issues
  #35, #36, #33, and #34. Verify: the PLUGIN_VERSION lockstep
  test is green.
- [ ] 6.3 File the documentation issue for this user-facing
  change (the AGENTS.md docs gate), referencing #35, #36,
  #33, and #34. Verify: the issue number is recorded for
  /uf.finale to link.
