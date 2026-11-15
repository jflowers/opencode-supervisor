# Tasks

## 1. Spike: verify public API unknowns (design D6)

- [x] 1.1 [P] Confirm the exact event shape for completed
  assistant reasoning parts in the installed public API (read the
  `@opencode-ai/sdk` Event union in the bun cache and the
  anomalyco core 1.19-era event definitions; if types are
  ambiguous, run a temporary probe plugin that logs events).
  Verify: the resolved shape and dedupe key are recorded in
  design.md D6.
- [x] 1.2 [P] Confirm whether `input.client.session.prompt`
  exposes `delivery: "steer"` in its options (SDK typings plus
  core session code). Verify: answer and chosen delivery strategy
  (steer vs. interrupt+memo fallback) recorded in design.md D6.
- [x] 1.3 [P] Confirm whether throwing inside
  `tool.execute.before` blocks the tool call (SDK typings, core
  tool execution path). Verify: answer and chosen block strategy
  (throw vs. `permission.ask` fallback) recorded in design.md D6.
- [x] 1.4 [P] Confirm the plugin entry export shape expected by
  `bunx oh-my-opencode install --local .` (default vs. named
  export; mirror `.opencode/plugins/*`). Verify: a minimal entry
  skeleton loads when registered locally.

## 2. Pure modules (src/)

- [x] 2.1 [P] Rework `src/auditor.ts`: replace the
  `session.provider.complete` path with an injected `invokeModel`
  function; add `severity` (`minor` | `severe`) to
  `PeerAuditOutcome`; include the session goal in the audit prompt
  for scope-drift findings; keep deterministic invariants and
  fail-open error handling (FR-001..FR-005). Verify: auditor unit
  tests pass with a mocked `invokeModel` under `bun test`.
- [x] 2.2 [P] Adjust `src/tool-guard.ts`: the file-path trace
  check MUST NOT block when the verified trace is empty;
  reward-hacking pattern checks unchanged; block reasons name the
  failed check and unmatched path (FR-009..FR-012). Verify:
  tool-guard unit tests cover empty-trace, unreferenced-path,
  and reward-hacking cases under `bun test`.
- [x] 2.3 [P] Create `src/memo.ts`: pure `buildMemo` over goal,
  solved items, and critiques — bounded counts, empty sections
  omitted, empty memo yields no output (FR-013..FR-017). Verify:
  new `test/memo.test.ts` covers populated, partial, empty, and
  over-bound inputs under `bun test`.
- [x] 2.4 [P] Confirm `src/stripper.ts` needs no change: existing
  stripper tests pass unmodified. Verify: `bun test` green with no
  edits to stripper or its tests.

## 3. Hook layer (index.ts rewrite)

- [x] 3.1 Rewrite `index.ts` as a thin `@opencode-ai/plugin`
  module: `server(input)` returning hooks, module-level state Maps
  keyed by session ID, config resolution (session plugin config →
  env → `pluginConfig` defaults), dispose cleanup, and an
  `invokeModel` adapter driving the auditor side session via
  `input.client.session.prompt` (D1, D2, D4). Verify: the plugin
  module imports cleanly under `bun test` and the config
  precedence unit test passes.
- [x] 3.2 [P] Wire the `event` hook: observe completed reasoning
  parts, dedupe by the spike-confirmed identity, strip, run
  invariants, then the side-session audit; record passed steps in
  the verified trace (FR-001, FR-002, FR-006). Verify: unit tests
  with synthetic events and a mocked client/invokeModel assert
  one audit per step and trace recording.
- [x] 3.3 [P] Wire critique delivery: on minor failure, send the
  critique as a steer prompt (or spike-confirmed fallback), bound
  deliveries to `maxRegenerations` per session, record overflow
  critiques; on severe failure, interrupt the session and deliver
  the critique (FR-007, FR-008). Verify: unit tests with a mocked
  client assert steer arguments, the bound, and interrupt on
  severe.
- [x] 3.4 [P] Wire goal capture (`chat.message`, first user
  message), solved-items logging (`tool.execute.after`), and memo
  injection (originally `experimental.chat.system.transform`,
  moved to `experimental.chat.messages.transform` by task 4.4)
  using `buildMemo`; registration must degrade gracefully when
  the experimental hook is absent (FR-013..FR-016). Verify: unit
  tests with mocked hooks assert goal capture, log bounding, and
  memo content in the transformed payload.
- [x] 3.5 [P] Wire the tool guard into `tool.execute.before`
  using the spike-confirmed block strategy against the session's
  verified trace (FR-009..FR-012). Verify: unit tests with mocked
  hook invocations assert blocks carry actionable reasons and
  empty-trace calls proceed.

## 4. Integration and documentation

- [x] 4.1 Run the full suite under both runtimes and fix
  failures: `bun test` and `node --test test/` green (CI parity
  per AGENTS.md). Verify: both commands exit zero.
- [x] 4.2 Update docs: rewrite `README.md` (architecture, config
  knobs, tested OpenCode version), add the `CHANGELOG.md` entry
  (including `OPENCODE_AUDITOR_ENDPOINT` removal), update the
  `AGENTS.md` structure section for `src/memo.ts`. Verify: the
  documented install and config commands run as written.
- [x] 4.3 Register locally through OpenCode's real mechanisms (the
  `plugin` array in `opencode.json` — `"./index.ts"` — or
  `opencode plugin <absolute path>`; see design.md spike 1.4) and run
  a live smoke test: induce a flawed reasoning step
  and a reward-hack attempt in a real session; observe steer
  critique, interrupt, tool block, and memo. Verify: observed
  behaviors recorded against FR-007, FR-008, FR-009, FR-016.
- [x] 4.4 Move memo delivery from
  `experimental.chat.system.transform` (mutations discarded by
  the OpenCode 1.19.0 build; design.md FR-016 amendment) to
  `experimental.chat.messages.transform` (wire-verified on the
  same build): append the memo as one trailing user message per
  user prompt, keep auditor-side-session suppression and the
  graceful registration guard, remove the dead system-transform
  registration (FR-016). Verify: both runtimes green with the
  hook-layer tests retargeted to the messages-transform payload.

## Workflow follow-up

- Run `/uf.review-council` and resolve all REQUEST CHANGES before
  PR (AGENTS.md review mandate).
- File the documentation issues for this user-facing change before
  merge (AGENTS.md documentation gate — both targets): the in-repo
  docs issue (filed: jflowers/opencode-reasoning-audit#2) and the
  org constitution's cross-repo issue in unbound-force/website
  (filed: unbound-force/website#321).
- Open the PR from `opsx/audit-supervisor` to `main`.
- Archive the change via the opsx archive workflow after the PR
  merges; verify the archived specs.
