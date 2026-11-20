# Tasks

## 1. Spec artifacts (FR-108)

- [x] 1.1 proposal.md
- [x] 1.2 specs/supervisor-config/spec.md (ADDED FR-108)
- [x] 1.3 tasks.md

## 2. Implementation

- [ ] 2.1 `hasProtectedSegmentRun`: optional home directory for a glob file name
- [ ] 2.2 `checkProtectedState`: pass `opencode/supervisor` for `approvals.json`

## 3. Tests

- [ ] 3.1 `opsx/*`, `docs/*.json` allowed; supervisor-directory globs still blocked
- [ ] 3.2 `checkProtectedState` allows the live `dispatch_review_runs` prose

## 4. Integration

- [ ] 4.1 typecheck, `bun test`, `npm run test:node`, `npm run verify:package`
- [ ] 4.2 README protected-state paragraph, CHANGELOG Unreleased
