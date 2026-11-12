# Tasks

## 1. Spec artifacts (FR-072..FR-075)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1..D6, risks, rollback)
- [x] 1.3 specs/supervisor-config/spec.md delta
- [x] 1.4 tasks.md

## 2. Pure rules (FR-073..FR-075)

- [x] 2.1 `src/agent-overrides.ts`: tool-name glob matcher,
  per-entry override validation with warnings, mutating-
  builtin rejection, exempt lookup, guard-lock filtering
- [x] 2.2 `src/config-file.ts`: parse `agentOverrides`
  (per-entry, warnings) and `lockGuards`
- [x] 2.3 `src/tool-guard.ts`: `verifyToolIntent` accepts an
  exempt-tool reason for the trace check
- [x] 2.4 unit tests for every rule in both directions

## 3. Hook wiring (FR-072..FR-075)

- [x] 3.1 `index.ts`: record the session agent in
  `chat.message`
- [x] 3.2 `index.ts`: global-only `agentOverrides`, guard
  lock, warnings, identity line
- [x] 3.3 `index.ts`: per-call exemption in
  `tool.execute.before`
- [x] 3.4 hook-layer tests for every spec scenario

## 4. Integration and release

- [x] 4.1 both runners green: `bun test` and
  `node --test test/*.test.ts`
- [x] 4.2 docs: README, CHANGELOG, AGENTS.md
- [ ] 4.3 `/uf.review-council` (runs inside OpenCode; draft PR until
  then; docs issue #50, website capabilities issue
  unbound-force/website#412, blog issue #52)
