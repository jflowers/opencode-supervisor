# Tasks

## 1. Spec artifacts (FR-099..FR-103)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1..D6, risks, rollback)
- [x] 1.3 specs/reasoning-audit/spec.md (ADDED FR-099..FR-103)
- [x] 1.4 tasks.md

## 2. Implementation

- [ ] 2.1 process-wide side-session registry (D1)
- [ ] 2.2 title-marker registration from session events (D2)
- [ ] 2.3 `tools: { '*': false }` on auditor and repair prompts (D3)
- [ ] 2.4 auditor timeout with abort and delete (D4)
- [ ] 2.5 process-wide concurrent audit cap (D5)
- [ ] 2.6 duplicate-load warning (D6)

## 3. Tests

- [ ] 3.1 two copies: cross-copy suppression
- [ ] 3.2 title-marker suppression
- [ ] 3.3 tools disabled in prompt bodies
- [ ] 3.4 timeout aborts, deletes, fails open
- [ ] 3.5 cap rejects before create
- [ ] 3.6 duplicate-load warning

## 4. Integration

- [ ] 4.1 typecheck, `bun test`, `npm run test:node`,
  `npm run verify:package`
- [ ] 4.2 CHANGELOG Unreleased entry, README troubleshooting
