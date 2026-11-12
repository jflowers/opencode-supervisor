# Tasks

## 1. Spec artifacts (FR-072..FR-075)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1..D7, risks, rollback)
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

## 4. Task-scoped profiles (fleet dispatch, review follow-up)

- [x] 4.1 spec artifacts: FR-072 session context (agent,
  command, parent), FR-073 `profiles`, FR-074 matching with
  inheritance; design D1, D2, D4, D7
- [ ] 4.2 `src/guard-profiles.ts` (renamed from
  `agent-overrides.ts`): profile validation, command
  normalization, ancestor-chain matching, grant union
- [ ] 4.3 `index.ts`: record command (`command.execute.before`)
  and parent (`session.created`/`session.updated`, cached
  lookup fallback); resolve profiles per tool call
- [ ] 4.4 tests for every new scenario on both runners
- [ ] 4.5 docs: README, CHANGELOG, AGENTS.md

## 5. Integration and release

- [x] 5.1 both runners green: `bun test` and
  `node --test test/*.test.ts`
- [x] 5.2 docs: README, CHANGELOG, AGENTS.md
- [ ] 5.3 `/uf.review-council` (runs inside OpenCode; draft PR until
  then; docs issue #50, website capabilities issue
  unbound-force/website#412, blog issue #52)
