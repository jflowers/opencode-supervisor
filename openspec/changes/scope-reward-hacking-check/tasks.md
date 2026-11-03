# Tasks

## 1. Spec artifacts (FR-071)

- [x] 1.1 proposal.md (why: mention-equals-use false
  positives force `blockRewardHacking: false`; what changes)
- [x] 1.2 design.md (D1..D4, risks, rollback)
- [x] 1.3 specs/tool-guard/spec.md delta (ADDED FR-071)
- [x] 1.4 tasks.md

## 2. Scan surfaces (FR-071)

- [x] 2.1 `src/tool-guard.ts`: pure `rewardHackingScanArgs`
  (read-only builtins → null; bash → full args; others →
  non-content keys, plus `content`/`newString` unless
  target-less or all-prose; never `oldString`)
- [x] 2.2 `src/tool-guard.ts`: `verifyToolIntent` feeds the
  helper's serialization to `matchRewardHackingMarker`
- [x] 2.3 guard tests: every FR-071 scenario, plus the
  existing FR-009 cases unchanged

## 3. Integration and release

- [x] 3.1 both runners green: `bun test` and
  `node --test test/*.test.ts`
- [x] 3.2 docs: README (knob table, tool-guard section),
  CHANGELOG entry, AGENTS.md architecture note
- [ ] 3.3 `/uf.review-council`, docs issue, PR
