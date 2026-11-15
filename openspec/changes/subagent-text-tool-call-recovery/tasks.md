# Tasks

## 1. Spec artifacts (FR-093, FR-096..FR-098)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1..D5, risks, rollback)
- [x] 1.3 specs/text-tool-call-recovery/spec.md (MODIFIED FR-093,
  ADDED FR-096..FR-098)
- [x] 1.4 tasks.md

## 2. Helpers (FR-097)

- [x] 2.1 `src/text-tool-call.ts`: `parseTaskResult`,
  `replaceTaskResult`, `lastTextOf`, `subagentTextToolCallNote`
- [x] 2.2 unit tests: parse and rewrite, missing frame, last text
  part, note text

## 3. Task-boundary correction (FR-096..FR-098)

- [x] 3.1 `index.ts`: `task` branch in `tool.execute.after`,
  synchronous correction loop with the subagent's agent and model,
  result rewrite and note, idle log wording (FR-093)
- [x] 3.2 hook-layer tests: corrected and rewritten, clean
  subagent, bound with note, background skipped, prompt failure,
  disabled, agent and model passed

## 4. Integration and release

- [x] 4.1 typecheck, `bun test`, `npm run test:node`,
  `npm run verify:package`
- [x] 4.2 docs: README §4.7, CHANGELOG Unreleased, AGENTS.md
- [x] 4.3 `/uf.review-council`
