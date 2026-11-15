# Tasks

## 1. Spec artifacts (FR-090..FR-095)

- [x] 1.1 proposal.md
- [x] 1.2 design.md (D1..D6, risks, rollback)
- [x] 1.3 specs/text-tool-call-recovery/spec.md (ADDED FR-090..FR-095)
- [x] 1.4 tasks.md

## 2. Detection (FR-090)

- [ ] 2.1 `src/text-tool-call.ts`: `maskCode`,
  `detectTextToolCall`, `assessLastTurn`, `textToolCallMessage`
- [ ] 2.2 unit tests: each shape, fenced and inline code, unknown
  tools, tool part after text, errored and non-assistant last
  messages

## 3. Correction (FR-091..FR-095)

- [ ] 3.1 `src/config-file.ts`: validate `textToolCall`
- [ ] 3.2 `index.ts`: config resolution, env knobs, session state
  (streak, checked id, in-flight), idle check, promptAsync steer,
  human-message reset
- [ ] 3.3 hook-layer tests: correction sent, real tool part
  untouched, cap, reset, double idle, side session, disabled,
  delivery failure, config-file validation

## 4. Integration and release

- [ ] 4.1 typecheck, `bun test`, `npm run test:node`,
  `npm run verify:package`
- [ ] 4.2 docs: README section and knob table, CHANGELOG
  Unreleased, AGENTS.md
- [ ] 4.3 `/uf.review-council`
