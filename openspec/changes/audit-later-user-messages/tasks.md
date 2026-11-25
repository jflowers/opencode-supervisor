# Tasks

## 1. Spec artifacts (FR-116)

- [x] 1.1 proposal.md
- [x] 1.2 specs/reasoning-audit/spec.md (ADDED FR-116)
- [x] 1.3 tasks.md

## 2. Implementation

- [ ] 2.1 `renderLaterUserMessages`, `LATER_USER_MESSAGES_NOTE`, caps in `src/auditor.ts`
- [ ] 2.2 `runPeerAudit` section after the goal; FR-113 sources include it
- [ ] 2.3 `chat.message` records later human messages (bounded); all three audit call sites pass them

## 3. Tests

- [ ] 3.1 rendering: order, count cap, character cap (unit)
- [ ] 3.2 prompt section placement and absence; FR-113 verifies a rule from a later message (unit)
- [ ] 3.3 hook layer: later human message reaches the audit prompt; synthetic steer does not; bound holds

## 4. Integration

- [ ] 4.1 typecheck, `bun test`, `npm run test:node`, `npm run verify:package`
- [ ] 4.2 README 4.1, CHANGELOG Unreleased, AGENTS.md
