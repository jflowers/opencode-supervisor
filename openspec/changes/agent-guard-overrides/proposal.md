# Proposal

## Why

Guard settings are all-or-nothing per project. Knowledge-
curation work hit the file-path trace check continuously
(corpus-scale reads, knowledge-store MCP calls that touch no
workspace file), and the only relief was
`requireStepReferenceInTools: false` in a committed project
config file. Project config outranks the global config file,
so that one committed file disables the check for every
agent in the repository — and copied into a development
repository it removes the check exactly where agents write
code. FR-071 (#46) already removed the reward-hacking side of
the problem; the trace-check side remains.

The supervisor also has no notion of what a session is doing,
so a relaxation cannot be scoped to the task that needs it.
Fleet dispatch makes this sharper: gh-hud starts every
unattended session as the `autonomy` agent and selects the task
with a slash command, configuration is deployed once per
machine, and instances are not restarted per task. The agent
alone cannot distinguish `/uf.review-pr` from `/dewey-distill`,
and subagent sessions a task starts carry neither.

## What Changes

- FR-072 (new): the supervisor tracks each session's context:
  the latest user message's agent (`chat.message`), the latest
  slash command (`command.execute.before`, kept until another
  command runs), and the parent session (`session.created` /
  `session.updated` events, one cached lookup as fallback).
- FR-073 (new): `profiles` — a list of grants, each with a
  `match` on `agent` and/or `command`. Honored only from the
  global config file; present in the project config file or
  plugin options, the key is dropped with a warning. An invalid
  profile is dropped with a warning without rejecting the rest
  of the global file.
- FR-074 (new): the first grant, `traceCheck.exemptTools` —
  tool-name globs whose calls skip the file-path trace check in
  sessions the profile applies to, including descendants of a
  matching session (subagents inherit the task's grant).
  Entries that match a file-mutating builtin (`bash`, `edit`,
  `write`, `patch`, `multiedit`, `apply_patch`) are rejected,
  so a profile can never disable the check where code is
  written. Reward-hacking, directive, protected-state, and gate
  checks still apply to exempt calls.
- FR-075 (new): `lockGuards` in the global config file. When
  `true`, `blockRewardHacking: false`,
  `requireStepReferenceInTools: false`, and
  `mode: "repair-only"` from the project config file or plugin
  options are dropped with a warning. The environment and the
  global file stay authoritative.

The `rewardHackingScope` knob sketched in #48 is not added:
FR-071 made execution-surface scanning the default for every
agent.

## Capabilities

### New Capabilities

- `supervisor-config`: FR-072..FR-075.

## Impact

- Code: a new pure `src/guard-profiles.ts` (validation, tool
  globs, matching with inheritance, guard-lock filtering);
  `src/config-file.ts` parses the two new keys;
  `src/tool-guard.ts` accepts an exempt reason; `index.ts`
  tracks session context, applies the global-only and lock
  rules at bootstrap, and resolves the applicable profiles per
  tool call.
- Tests: unit tests for the pure module; hook-layer tests for
  context tracking, inheritance, global-only scoping, and the
  lock.
- Docs: README (config keys, guard section), CHANGELOG,
  AGENTS.md architecture note.
- Closes #48 and #47 (#47's exemptions are the profile
  `traceCheck.exemptTools`; its "consider read-only tools"
  item is resolved as not exempting them by default — see
  design D3).
- Risk: bounded. Without a global `profiles` or `lockGuards`,
  behavior is unchanged. Agent and command names are weak keys
  (any repository can ship `.opencode/agents/curator.md`),
  which is why grants come only from the user's global file
  and only narrow.

## Constitution Alignment

### I. Autonomous Collaboration

**Assessment**: PASS

Exempt-call verdicts name the profile; dropped
keys and entries warn once at the first hook.

### II. Composability First

**Assessment**: PASS

Two opt-in keys; defaults unchanged.

### III. Observable Quality

**Assessment**: PASS

The identity line reports `lockGuards` and the profile names.

### IV. Testability

**Assessment**: PASS

All rules are pure functions in `src/guard-profiles.ts`,
covered in both directions; hook tests cover the wiring.

### V. Security by Default

**Assessment**: PASS

Grants come only from the user's global file, validate per
profile, and only narrow: unknown keys and file-mutating builtin
globs are rejected, and the guard lock drops guard-disabling
values from lower-trust tiers.
