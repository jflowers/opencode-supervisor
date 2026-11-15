# Proposal

## Why

The supervisor is currently push-only: it audits, steers, blocks, and
memoizes, but the primary agent cannot ask for any of it. The locked
roadmap's agent-console pillar starts here. Reminders are the first
self-serve surface because they solve a concrete failure mode: facts
discovered mid-session (a dead end, an environment quirk, a decision,
a user constraint) live in the transcript until context compaction or
drift erases them. Plugin-owned reminders re-enter the conversation
through the memo every turn, so they survive compaction, and the
tool-result echo delivers them immediately even on gateways that drop
pushed system messages (README section 9).

## What Changes

- Added: a `remind_me` tool offered to supervised sessions; the agent
  registers a reminder and gets back its id and the stored text.
- Added: a `forget_reminder` tool; the agent removes a reminder by id
  and gets an actionable listing when the id is unknown.
- Added: reminders in session state and a `Reminders:` section in the
  supervisor memo, ids included so `forget_reminder` works from the
  memo alone.
- Added: `OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS` (default 10) with
  the established precedence chain (session config, then environment,
  then default).
- Added: text hygiene — whitespace-only reminders are rejected with an
  actionable message; stored text is truncated at a fixed 2000-char
  ceiling.
- Changed: version 2.1.0 (backward-compatible minor); auditor side
  sessions get inert tool results.

## Capabilities

### New Capabilities

- `agent-reminders`: the agent console's reminder surface — the two
  tools, the session-state store, memo rendering, capacity bounds,
  side-session inertness, and text hygiene (FR-020..FR-025).

### Modified Capabilities

- `supervisor-memo`: the memo gains a `Reminders:` section and a
  `maxReminders` limit. The requirement is specified in this change's
  `agent-reminders` delta (FR-022, FR-023) to keep the delta
  self-contained; the memo module remains the rendering pipeline.

## Impact

- **Code**: new `src/reminders.ts` (pure); `src/memo.ts` (reminders
  input, limit, section); `index.ts` (SessionState, env var, config
  resolution, tool registrations); `package.json` (version,
  `test:node` file list).
- **Docs**: `README.md` (agent-console section, config table row),
  `CHANGELOG.md` (2.1.0), `AGENTS.md` (structure, test command).
- **Users**: supervised agents gain two tools; no migration — new
  env var is optional with a default.
- **Out of scope**: the remaining agent-console tools (recall_progress,
  report_solved, request_audit, declare_intent, acknowledge_critique,
  refine_goal — Change D), engineer directives (Change C), conditional
  reminders, and the rebrand advisories tracked in #9.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The change is precisely about agent self-sufficiency: the primary
agent registers and manages its own working memory instead of relying
on the transcript or the operator. Tool descriptions are written as
meta-prompts so future agents discover the surface without docs.

### II. Composability First

**Assessment**: PASS

`src/reminders.ts` is a pure module with no clock, randomness, or IO;
the hook layer injects ids and timestamps. No new dependency — arg
schemas use the plugin SDK's zod re-export (`tool.schema`). Reminders
degrade gracefully: without them the memo is unchanged.

### III. Observable Quality

**Assessment**: PASS

Reminders are observable three ways: the tool-result echo, the memo
section (with ids), and the CHANGELOG 2.1.0 entry. Capacity and text
bounds make the surface's resource cost predictable.

### IV. Testability

**Assessment**: PASS

The pure module is tested directly; the tools are tested with mocked
`ToolContext`s; the memo integration is tested through `buildMemo`.
All suites run under both Bun and Node 22+.

### V. Security by Default

**Assessment**: PASS

The tools write plugin-local state only — no filesystem, network, or
shell. Storage and text are bounded, whitespace-only input is
rejected, side sessions get inert results, and no existing guard is
weakened.
