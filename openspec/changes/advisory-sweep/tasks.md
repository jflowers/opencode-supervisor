# Tasks

## 1. Spec artifacts (FR-077..FR-079)

- [x] 1.1 proposal.md (why: open council advisories from #9,
  #13, #17, #22 per #55; what changes)
- [x] 1.2 design.md (D1..D9, risks, rollback)
- [x] 1.3 specs/supervisor-tools/spec.md delta (ADDED FR-077,
  FR-078)
- [x] 1.4 specs/engineer-directives/spec.md delta (ADDED
  FR-079)
- [x] 1.5 tasks.md

## 2. Console honesty and caps (FR-077, FR-078)

- [ ] 2.1 `index.ts`: `remind_me` returns the disabled result
  at cap ≤ 0 without consuming an id; `report` likewise; both
  interpolate the text constants in their truncation notes
- [ ] 2.2 `src/memo.ts`: `normalizeMemoLimits`; `buildMemo`
  normalizes and applies each cap once
- [ ] 2.3 `src/console.ts`: `MAX_AUDIT_FOCUS`,
  `prepareAuditFocus`; `index.ts` `request_audit` uses it
  before stripping and notes truncation
- [ ] 2.4 `index.ts`: `recall` reads state with `peek`
- [ ] 2.5 tests: cap-0 results for both tools, older limits
  objects, focus cap (prompt, trace, result), session-config
  override of `maxOnDemandAudits`

## 3. Directive anchoring and provenance (FR-079)

- [x] 3.1 regression tests first: `./`, `~`, absolute, and
  nested spellings against `forbidPath` and `when` globs;
  record which fail on the unfixed code
- [x] 3.2 `src/directives.ts`: `matchesPaths` (whole path or
  slash-boundary suffix) for enforcement and triggers
- [x] 3.3 `src/directives.ts`: `extractDirectivePaths` (nested,
  bounded); guard enforcement and the trigger call site use it
- [x] 3.4 `src/directives.ts`: `MAX_DIRECTIVE_FILES`;
  `index.ts` loader applies it at read time with one warning
- [x] 3.5 `src/directives.ts`: `describeDirectiveSources`;
  identity line names ids and sources

## 4. Hygiene refactors (no behavior change)

- [ ] 4.1 `src/plugin-id.ts` `PLUGIN_ID` used by `index.ts`,
  `src/auditor.ts`, `src/plugin-log.ts`
- [ ] 4.2 `src/records.ts`: `SolvedItem`, `CritiqueRecord`,
  `takeMostRecent`; break the memo ↔ console cycle; reminders
  and reports reuse the helper
- [x] 4.3 `src/directives.ts`: generic `normalizeRules`, shared
  `buildDirective`, `compileTriggers` precompiled at server
  start
- [x] 4.4 `extractArgPaths`: confirm a direct test exists (keep
  the export) or unexport — already done: direct FR-066 tests
  in `test/audit.test.ts` import it; export kept
- [ ] 4.5 `test/mocks.ts`: `toolContext`,
  `completedReasoningPart`, `SUPERVISOR_ENV_NAMES`,
  `withCleanSupervisorEnv`; remove the copies; drop the unused
  `REPORT_KINDS` import

## 5. Integration

- [ ] 5.1 both runners green: `bun test` and `npm run
  test:node`; `bun run typecheck`; `npm run verify:package`
- [ ] 5.2 docs: CHANGELOG entry, AGENTS.md (structure, new
  modules), README (directive glob anchoring, cap-0 results)
- [ ] 5.3 `/uf.review-council`
