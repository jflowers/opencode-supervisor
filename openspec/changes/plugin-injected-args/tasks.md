# Tasks

## 1. Spec artifacts (FR-106, FR-107)

- [x] 1.1 proposal.md
- [x] 1.2 specs/reasoning-audit/spec.md (ADDED FR-106)
- [x] 1.3 specs/supervisor-config/spec.md (ADDED FR-107)
- [x] 1.4 tasks.md

## 2. Implementation

- [x] 2.1 `src/plugin-injected.ts`: read and render producer records
- [x] 2.2 `runPeerAudit` section and `PLUGIN_INJECTED_ARGS_NOTE`; pass it at both audit call sites
- [x] 2.3 `hasProtectedSegmentRun`: file runs match globs only at the last segment

## 3. Tests

- [x] 3.1 reader, bounds, malformed state, rendering (unit)
- [x] 3.2 prompt section present only with records (unit and hook layer)
- [x] 3.3 `**/*.md` and `src/*/x.ts` allowed; glob spellings of the files still blocked

## 4. Integration

- [x] 4.1 typecheck, `bun test`, `npm run test:node`, `npm run verify:package`
- [x] 4.2 README 4.8, CHANGELOG Unreleased
