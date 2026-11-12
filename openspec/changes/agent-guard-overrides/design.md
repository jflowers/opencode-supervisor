# Design

## Context

`resolveHookConfig` tiers every knob as session → env →
project file → plugin options → global file → defaults
(FR-056). `verifyToolIntent` runs the trace check when
`requireStepReferenceInTools` is true, exempting only the
plugin's own console tools (FR-065). No hook knows the
session's agent today, though `chat.message` receives
`agent` in its input (`@opencode-ai/plugin` 1.19.4).

## Goals

- Let the user grant one agent a narrow trace-check
  exemption without touching any other agent.
- Stop a committed project config from disabling guards when
  the user asks for that.

## Non-Goals

- Per-agent reward-hacking settings: FR-071 already scopes
  that check for every agent.
- Per-agent directive or gate overrides. Engineer policy
  stays agent-independent.
- External-access supervision (#45).

## Decisions

### D1 Agent tracking

`chat.message` stores `hookInput.agent` (a non-empty string)
on the session state on every user message, in every mode,
before any early return. A later message with another agent
replaces it. Auditor side sessions are skipped like every
other hook. A session with no recorded agent gets no
override.

### D2 Override shape and validation

```json
"agentOverrides": {
  "curator": { "traceCheck": { "exemptTools": ["dewey_*"] } }
}
```

Agent names match exactly (OpenCode agent keys are case-
sensitive). Validation is per entry: an entry with an unknown
key, a non-object, or an invalid `exemptTools` is dropped
with a warning that names the agent and the problem; the
remaining entries and the rest of the file stay in force.
This departs from the whole-file rejection convention
(FR-057) on purpose — rejecting the whole global file for a
bad override would also drop `lockGuards`, failing open on
the lock. A non-object `agentOverrides` drops only that key.

Unknown keys inside an entry are rejected rather than
ignored, so `{ "curator": { "blockRewardHacking": false } }`
warns instead of silently doing nothing.

### D3 Narrow, never disable

`exemptTools` entries are tool-name globs (`*` any run, `?`
one character, anchored, case-sensitive). An entry that
matches any file-mutating builtin — `bash`, `edit`, `write`,
`patch`, `multiedit`, `apply_patch` — is rejected; that also
rejects `*` and other catch-alls. An exempt call skips only
the file-path trace check: reward-hacking (FR-071), directive
enforcement (FR-028), and approve/review gates still run.

Read-only builtins (`read`, `grep`, `glob`) are not exempted
by default (#47's open question): their path arguments are
the trace check's evidence that reasoning preceded the read,
and glob-form reasoning (FR-069) already covers bulk reads. A
user may still list them for an agent.

### D4 Global file only

Agent names are a weak key: any repository can define an
agent called `curator`. Grants therefore come only from the
user's global config file. `agentOverrides` in the project
file or plugin options (which may live in a project
`opencode.json`) is removed with one warning per source. No
environment variable is offered: JSON in the environment is
error-prone, and the global file is the user-controlled tier.

### D5 Guard lock

`lockGuards: true` in the global file removes
`blockRewardHacking: false` and
`requireStepReferenceInTools: false` from the project file
and plugin options tiers before resolution, with one warning
per removed key. `true` values pass through. The environment
and the global file are user-controlled and stay
authoritative. `lockGuards` from any other tier is ignored
with a warning (a project cannot lock or unlock itself).

### D6 Observability

The identity line adds `lockGuards=<bool>` and, when present,
`agentOverrides: <names>`. An exempt verdict's reason reads
"exempt from the file-path trace check for agent '<a>' by
global agentOverrides". Warnings from D2, D4, and D5 join the
deferred bootstrap warnings.

## Risks

- A repository-defined agent that reuses a granted name gets
  the grant. Mitigation: grants are narrow (D3), and gates
  and directives still apply.
- Agent switches mid-session take effect at the next user
  message, not mid-turn.

## Rollback

Remove `agentOverrides` and `lockGuards` from the global
file; behavior returns to today's.
