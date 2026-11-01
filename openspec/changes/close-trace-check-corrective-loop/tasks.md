# Tasks

## 1. Spec artifacts (FR-069, FR-070)

- [x] 1.1 proposal.md (why: session evidence, two structural
  causes; what changes; capability impact)
- [x] 1.2 design.md (D1..D6 decisions, risks, rollback)
- [x] 1.3 specs/trace-check/spec.md delta (MODIFIED FR-067;
  ADDED FR-069, FR-070)
- [x] 1.4 tasks.md
- [x] 1.5 `openspec/specs/trace-check/spec.md` baseline: sync
  FR-062..FR-068 byte-identical from the archived
  `repair-trace-check-pipeline` delta (that change had no main
  spec to modify) so this change's FR-069/FR-070 additions and
  FR-067 modification diff against a real base

## 2. Trace-side pattern satisfaction (FR-069)

- [x] 2.1 `src/tool-guard.ts`: in `findUnreferencedPath`'s
  concrete branch, on full/basename miss test trace pattern
  tokens that are path-scoped (contain `/`) via
  `globPathToRegExp` against the lowered full token and its
  slash-boundary suffixes; reuse the lazy `traceTokens` array
- [x] 2.2 `src/tool-guard.ts`: plain block reason names both
  corrective forms (explicit path/basename or path-scoped
  pattern) and the settle-then-retry instruction (FR-070 text)
- [x] 2.3 guard tests: path-scoped glob covers a concrete
  write; bare `*.md` does not; absolute argument matches by
  suffix; case-insensitive; empty-trace allow unchanged;
  concrete full/basename matching unchanged

## 3. Pending-audit awareness (FR-070, FR-067)

- [x] 3.1 `index.ts`: `pendingAudits` becomes
  `Map<Promise<unknown>, string[]>`; register the continuation
  synchronously with a step-token box it fills after `buildConfig`
  + `stripNarrative` resolve (FR-067's registration contract
  preserved — the hoist was rejected in review); deregister in the
  finally as today
- [x] 3.2 `index.ts`: covered-wait branch — when the trace
  block's unmatched token is named by an in-flight audit's
  tokens, a timed-out wait fails open against
  `state.coveredTimeoutFailOpens` (new) up to
  `maxCoveredTimeoutFailOpens`, blocking past the cap with the
  audit named; uncovered waits unchanged; both paths logged
- [x] 3.3 `index.ts`: eviction detection — snapshot the map
  before the wait; after a settled wait that still blocks, a
  departed entry whose tokens covered the unmatched token
  yields the honest evicted-correction reason
- [x] 3.4 hook-layer tests: covered timeout fails open
  uncharged; covered timeout past the cap blocks; uncovered
  timeout still charges `maxTimeoutFailOpens`; settled-evicted
  reason; migrate existing `pendingAudits` Set-API tests to the
  Map (audit.test.ts around lines 2464-2659)

## 4. Config knob (maxCoveredTimeoutFailOpens)

- [x] 4.1 `src/config-file.ts`: add the numeric key (project +
  global tiers, non-negative integer validation)
- [x] 4.2 `index.ts`: `pluginConfig` default 6; resolution
  through the full precedence chain next to
  `maxTimeoutFailOpens`
- [x] 4.3 `test/config-file.test.ts`: validation failures and
  tier resolution for the new knob

## 5. Integration and release

- [x] 5.1 both runners green: `bun test` and
  `node --test test/*.test.ts`
- [x] 5.2 docs: README (trace-check sections, knob table),
  CHANGELOG entry, AGENTS.md architecture bullets (FR-069,
  FR-070)
- [ ] 5.3 `/uf.review-council` (docs #42, blog #43,
  unbound-force/website capabilities issue), PR
