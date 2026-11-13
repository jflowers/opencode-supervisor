# Tasks

## 1. Spec artifacts (FR-076)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1..D4, risks, rollback)
- [x] 1.3 specs/supervisor-config/spec.md delta (ADDED FR-076)
- [x] 1.4 tasks.md

## 2. Detection (FR-076)

- [x] 2.1 `src/config-file.ts`: pure `detectLegacyEnvNames(env)`
  and `legacyEnvWarning(names)` (replacement mapping, removed
  endpoint, 10-name bound)
- [x] 2.2 `index.ts`: push the warning onto `bootstrapWarnings`
- [x] 2.3 tests: detector and message units; hook-layer warning
  with no value leak; no-warning case; FR-019 legacy-ignored
  regression

## 3. Integration and release

- [x] 3.1 both runners green: `bun test` and `npm run test:node`
- [x] 3.2 docs: README §10.2 note, CHANGELOG Unreleased entry
- [ ] 3.3 `/uf.review-council`
