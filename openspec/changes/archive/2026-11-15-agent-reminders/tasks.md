# Tasks

## 1. Spec artifacts

- [x] 1.1 [P] Write `proposal.md`, `design.md`,
  `specs/agent-reminders/spec.md` (FR-020..FR-025), and this
  `tasks.md`. Verify: every scenario carries a GIVEN line; RFC 2119
  wording; line length under 72.

## 2. Implementation

- [x] 2.1 [P] Implement `src/reminders.ts` as a pure module:
  `Reminder`, `addReminder`, `clearReminder`, `renderReminders`,
  `MAX_REMINDER_TEXT_LENGTH` (FR-020, FR-021, FR-022, FR-025).
  Verify: module has no clock, randomness, or IO.
- [x] 2.2 [P] Extend `src/memo.ts`: `MemoInput.reminders`,
  `MemoLimits.maxReminders`, and the `Reminders:` section via
  `renderReminders` (FR-022, FR-023). Verify: `test/memo.test.ts`
  still green.
- [x] 2.3 [P] Wire `index.ts`: `SessionState.reminders` +
  `reminderSeq`, `ENV_MEMO_MAX_REMINDERS`, `resolveHookConfig`
  `maxReminders`, `PLUGIN_VERSION` 2.1.0 (FR-023). Verify: `bun test`
  green.
- [x] 2.4 [P] Register `remind_me` / `forget_reminder` on the hooks
  `tool` map with meta-prompt descriptions, side-session inertness,
  and actionable results (FR-020, FR-021, FR-024, FR-025). Verify:
  tool-layer tests green.

## 3. Tests

- [x] 3.1 [P] Write `test/reminders.test.ts`: module tests (add,
  clear, render, bounds, truncation, whitespace), memo integration,
  and tool-layer tests with mocked `ToolContext` (FR-020..FR-025).
  Verify: new suite green under `bun test`.
- [x] 3.2 Update `package.json` `test:node` and the AGENTS.md test
  command to include `test/reminders.test.ts`. Verify: `node --test`
  runs all three files green.

## 4. Verification and docs

- [x] 4.1 Run both runtimes green: `bun test` and
  `node --test test/audit.test.ts test/memo.test.ts
  test/reminders.test.ts` (CI parity per AGENTS.md).
- [x] 4.2 [P] Docs gate: `CHANGELOG.md` 2.1.0 entry; `README.md`
  agent-console section (remind_me / forget_reminder) and config
  table row for `OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS`;
  `AGENTS.md` structure rows for `src/reminders.ts` and the new test
  file. Verify: documented default (10) matches code; tool names
  match registrations.

## 5. Publication

- [x] 5.1 File the documentation issue for this user-facing change
  before merge, naming both gate targets: this repo and
  `unbound-force/website` (constitution cross-repo documentation
  rule). Filed: #11 (this repo, label documentation) and
  unbound-force/website#327.
- [x] 5.2 Run `/uf.review-council` and resolve all REQUEST CHANGES
  before PR (AGENTS.md review mandate). Round 1 verdict: APPROVE WITH
  ADVISORIES (architect/curator/guard/sre all approved; adversary
  infra-failed — opus endpoint down, 0 findings, excluded per
  RD-FR-025). Docs-level findings fixed in the advisory-sweep commit;
  code-level advisories tracked in #13; blog coverage tracked in #12.
- [x] 5.3 Open the PR from `opsx/agent-reminders` to `main`; archive
  the change via the opsx archive workflow after merge.

## Workflow follow-up

- Changes C (`engineer-directives`) and D (`supervisor-tools`) build
  on the session-state layer this change extends.
- Code-level advisories from the rebrand review stay tracked in #9
  (fast-follow; out of scope here).
- Review-council gate and coverage issues for this change: #11
  (in-repo docs gate), unbound-force/website#327 (cross-repo docs
  gate), #12 (blog), #13 (code-level advisories from this change's
  council).
