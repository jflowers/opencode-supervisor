# Tasks

## 1. Spec artifacts (FR-111, FR-112)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1, D2, risks, rollback)
- [x] 1.3 specs/reasoning-audit/spec.md (ADDED FR-111, FR-112)
- [x] 1.4 tasks.md

## 2. Implementation

- [x] 2.1 skip critique delivery for parented sessions (D1)
- [x] 2.2 steer-target resolver from the latest user message (D2)
- [x] 2.3 pass agent and model on critique and text tool-call steers

## 3. Tests

- [x] 3.1 severe and minor findings in a parented session: no
  abort, no steer, withheld
- [x] 3.2 critique steer carries agent and model from chat.message
- [x] 3.3 critique steer falls back to the session's messages
- [x] 3.4 text tool-call correction carries agent and model

## 4. Integration

- [x] 4.1 typecheck, `bun test`, `npm run test:node`,
  `npm run verify:package`
- [x] 4.2 CHANGELOG Unreleased entry
