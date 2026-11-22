# Tasks

## 1. Spec artifacts (FR-108, FR-109, FR-110)

- [x] 1.1 proposal.md
- [x] 1.2 specs/supervisor-config/spec.md (ADDED FR-108, FR-109, FR-110)
- [x] 1.3 tasks.md

## 2. Implementation

- [x] 2.1 `hasProtectedSegmentRun`: optional home directory for a glob file name
- [x] 2.2 `checkProtectedState`: pass `opencode/supervisor` for `approvals.json`
- [ ] 2.3 `checkProtectedState`: per-key lens; reasons name the key, drop the path (FR-109)
- [ ] 2.4 Custom tools: whitespace values checked whole except shell-style keys (FR-110)

## 3. Tests

- [x] 3.1 `opsx/*`, `docs/*.json` allowed; supervisor-directory globs still blocked
- [x] 3.2 `checkProtectedState` allows the live `dispatch_review_runs` prose
- [ ] 3.3 Reason wording: names key, no path, no-approval statement
- [ ] 3.4 Live `checkpoint` data allowed; spaced whole path and shell keys still blocked; builtins unchanged

## 4. Integration

- [x] 4.1 typecheck, `bun test`, `npm run test:node`, `npm run verify:package`
- [x] 4.2 README protected-state paragraph, CHANGELOG Unreleased
- [ ] 4.3 README, CHANGELOG, AGENTS for FR-109/FR-110
