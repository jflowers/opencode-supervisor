# Tasks

## 1. Spec artifacts (FR-114)

- [x] 1.1 proposal.md
- [x] 1.2 specs/reasoning-audit/spec.md (ADDED FR-114)
- [x] 1.3 tasks.md

## 2. Implementation

- [x] 2.1 `excerptToolOutput` and `SolvedItem.detail`; store it in `tool.execute.after`
- [x] 2.2 `renderSessionProgress` shows excerpts for the newest calls; note update
- [x] 2.3 `LATER_PROGRESS_NOTE` and the `runPeerAudit` later-calls section
- [x] 2.4 one re-check of a failed peer finding with the calls that completed during the audit

## 3. Tests

- [x] 3.1 excerpt, rendering, and later-section units
- [x] 3.2 issue #91 regression: r3 line from an earlier output's tail, conclude result from the re-check, no finding delivered
- [x] 3.3 no re-check without later calls; failing re-check replaces the finding; fail-open re-check keeps it
- [x] 3.4 review fixes: severe findings skip the re-check; notes keep absent-call claims flaggable, limit later results to evidence, mark output as data
- [x] 3.5 later-calls section moves before the steps, so the steps stay last

## 4. Integration

- [x] 4.1 typecheck, `bun test`, `npm run test:node`, `npm run verify:package`
- [x] 4.2 README 4.1, CHANGELOG Unreleased, AGENTS.md
