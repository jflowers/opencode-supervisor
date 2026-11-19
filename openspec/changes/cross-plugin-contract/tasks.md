# Tasks

## 1. Spec artifacts (FR-104, FR-105)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1..D4, risks, rollback)
- [x] 1.3 specs/tool-arg-repair/spec.md (ADDED FR-104)
- [x] 1.4 specs/reasoning-audit/spec.md (ADDED FR-105)
- [x] 1.5 tasks.md

## 2. Implementation

- [x] 2.1 `preserveUntouchedKeys` in `src/arg-repair.ts` (D1..D3)
- [x] 2.2 apply it to deterministic and model repairs in `repairToolArgs`

## 3. Tests

- [x] 3.1 injected keys survive deterministic and model repair (unit)
- [x] 3.2 flagged keys, renames, validity guard (unit)
- [x] 3.3 hook layer: injected keys survive `tool.execute.before`
- [x] 3.4 registry reachable under the global symbol without import
- [x] 3.5 audit and repair side sessions registered before their
  `session.created` and first message event reach a later plugin

## 4. Integration

- [x] 4.1 typecheck, `bun test`, `npm run test:node`,
  `npm run verify:package`
- [x] 4.2 README 4.5 and 4.8, CHANGELOG Unreleased
