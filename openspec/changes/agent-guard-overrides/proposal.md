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

The supervisor also has no notion of which agent a session is
running, so a relaxation cannot be scoped to the dedicated
`curator` agent (unbound-force/dewey#152) that needs it.

## What Changes

- FR-072 (new): the supervisor tracks each session's agent
  from the `chat.message` hook input; the latest user message
  wins.
- FR-073 (new): `agentOverrides` — per-agent overrides that
  narrow where a guard applies. Honored only from the global
  config file; present in the project config file or plugin
  options, the key is dropped with a warning. An invalid
  override entry is dropped with a warning without rejecting
  the rest of the global file.
- FR-074 (new): the first override key,
  `traceCheck.exemptTools` — tool-name globs whose calls skip
  the file-path trace check in that agent's sessions. Entries
  that match a file-mutating builtin (`bash`, `edit`, `write`,
  `patch`, `multiedit`, `apply_patch`) are rejected, so an
  override can never disable the check where code is written.
  The reward-hacking check, directive enforcement, and
  approve/review gates still apply to exempt calls.
- FR-075 (new): `lockGuards` in the global config file. When
  `true`, `blockRewardHacking: false` and
  `requireStepReferenceInTools: false` from the project
  config file or plugin options are dropped with a warning.
  The environment and the global file stay authoritative.

The `rewardHackingScope` knob sketched in #48 is not added:
FR-071 made execution-surface scanning the default for every
agent.

## Capabilities

### New Capabilities

- `supervisor-config`: FR-072..FR-075.

## Impact

- Code: a new pure `src/agent-overrides.ts` (validation, tool
  globs, guard-lock filtering); `src/config-file.ts` parses
  the two new keys; `src/tool-guard.ts` accepts an exempt-tool
  predicate; `index.ts` tracks the session agent, applies the
  global-only and lock rules at bootstrap, and resolves the
  agent's override per tool call.
- Tests: unit tests for the pure module; hook-layer tests for
  agent tracking, global-only scoping, and the lock.
- Docs: README (config keys, guard section), CHANGELOG,
  AGENTS.md architecture note.
- Closes #48 and #47 (#47's exemptions are the per-agent
  `traceCheck.exemptTools`; its "consider read-only tools"
  item is resolved as not exempting them by default — see
  design D3).
- Risk: bounded. Without a global `agentOverrides` or
  `lockGuards`, behavior is unchanged. Agent names are a weak
  key (any repository can ship `.opencode/agents/curator.md`),
  which is why grants come only from the user's global file
  and only narrow.

## Constitution Alignment

### I. Autonomous Collaboration

**Assessment**: PASS

Exempt-call verdicts name the agent and the override; dropped
keys and entries warn once at the first hook.

### II. Composability First

**Assessment**: PASS

Two opt-in keys; defaults unchanged.

### III. Observable Quality

**Assessment**: PASS

The identity line reports `lockGuards` and the agents that
carry overrides.

### IV. Testability

**Assessment**: PASS

All rules are pure functions in `src/agent-overrides.ts`,
covered in both directions; hook tests cover the wiring.

### V. Security by Default

**Assessment**: PASS

Grants come only from the user's global file, validate per
entry, and only narrow: unknown keys and file-mutating builtin
globs are rejected, and the guard lock drops guard-disabling
values from lower-trust tiers.
