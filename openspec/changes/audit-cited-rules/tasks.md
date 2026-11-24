# Tasks

## 1. Spec artifacts (FR-113)

- [x] 1.1 proposal.md
- [x] 1.2 specs/reasoning-audit/spec.md (ADDED FR-113)
- [x] 1.3 tasks.md

## 2. Implementation

- [ ] 2.1 Prompt: `rule` field, verbatim quote, rule scope, unaddressed steps
- [ ] 2.2 `normalizeVerdict` reads `rule`; `verifyCitedRule` in `src/auditor.ts`
- [ ] 2.3 `runPeerAudit` drops unverified findings (fail open) and appends `Rule cited:`

## 3. Tests

- [ ] 3.1 `verifyCitedRule`: normalization, short quotes, absent text (unit)
- [ ] 3.2 `runPeerAudit`: invented rule dropped, verbatim rule kept and appended, no-rule finding unchanged, directive rule verified (unit)
- [ ] 3.3 prompt carries the rule instructions (unit)

## 4. Integration

- [ ] 4.1 typecheck, `bun test`, `npm run test:node`, `npm run verify:package`
- [ ] 4.2 README 4.1, CHANGELOG Unreleased
