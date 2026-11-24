# Tasks

## 1. Spec artifacts (FR-111)

- [x] 1.1 proposal.md
- [x] 1.2 specs/reasoning-audit/spec.md (ADDED FR-111)
- [x] 1.3 tasks.md

## 2. Implementation

- [ ] 2.1 `renderSessionProgress` and `SESSION_PROGRESS_NOTE` in `src/auditor.ts`
- [ ] 2.2 `runPeerAudit` section; pass the solved-items log at both audit call sites

## 3. Tests

- [ ] 3.1 rendering, cap, truncation note (unit)
- [ ] 3.2 prompt section present only with calls (unit)
- [ ] 3.3 issue #87 regression at the hook layer: goal ordering rule, prerequisite tool call earlier, edit step, no failing finding delivered

## 4. Integration

- [ ] 4.1 typecheck, `bun test`, `npm run test:node`, `npm run verify:package`
- [ ] 4.2 README 4.1, CHANGELOG Unreleased
