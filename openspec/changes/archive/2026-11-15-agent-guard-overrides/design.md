# Design

## Context

`resolveHookConfig` tiers every knob as session → env →
project file → plugin options → global file → defaults
(FR-056). `verifyToolIntent` runs the trace check when
`requireStepReferenceInTools` is true, exempting only the
plugin's own console tools (FR-065). No hook knows what a
session is doing today, though the plugin API exposes it:
`chat.message` receives the user message's `agent`,
`command.execute.before` receives the slash command and its
session, and `session.created` / `session.updated` events
carry a session's `parentID` (`@opencode-ai/plugin` 1.19.4).

Fleet dispatch (gh-hud) starts every unattended session with
one agent (`autonomy`) and selects the task with a slash
command (`opencode run --agent autonomy --command
uf.fix-ci 846`, or a TUI started with `--prompt "/<command>"`).
Configuration is deployed once per machine and instances are
not restarted per task, so per-instance settings cannot be
task-appropriate. The agent alone cannot tell
`/uf.review-pr` from `/dewey-distill`; the command can.

## Goals

- Let the user grant a narrow trace-check exemption to one
  task — a slash command, an agent, or both — without
  touching any other session, and without restarts.
- Carry the grant into the subagent sessions the task starts.
- Stop a committed project config from disabling guards when
  the user asks for that.

## Non-Goals

- Per-task reward-hacking settings: FR-071 already scopes
  that check for every session.
- Per-task directive or gate overrides. Engineer policy stays
  task-independent.
- External-access supervision (#45).
- Dispatch metadata from outside OpenCode (for example a
  gh-hud task label in the environment): the command already
  identifies the task inside the session.

## Decisions

### D1 Session context

Each session records three facts, in every mode:

- `agent`: from `chat.message`, the latest user message's
  `agent` (a later message replaces it).
- `command`: from `command.execute.before`, the latest slash
  command run in the session, without a leading `/`. It scopes
  one task: it stays while the session works, including
  through messages plugins inject during the task (an
  auto-question summary is a non-synthetic user message), and
  ends at the first human-typed (non-synthetic) user message
  after the session goes idle (`session.idle`, or
  `session.status` idle), unless that message is itself a
  slash command. Review round 2: "until another command runs"
  let a command's grant outlive its task in interactive
  sessions.
- `parentID`: from `session.created` / `session.updated`
  events. When a session's parent is unknown at a tool call,
  one `client.session.get` lookup runs. A result ("no
  parent" included) is cached; a failure or timeout is
  treated as no parent for that call but not cached — it is
  retried after a 30 s backoff, and a later session event
  still supplies the parent. A tool call resolves the
  lineage only when some profile's `exemptTools` matches the
  tool, so other calls never pay for lookups.

Auditor side sessions are skipped like every other hook.

### D2 Profile shape and validation

```json
"profiles": [
  {
    "name": "distill",
    "match": { "command": "dewey-distill" },
    "traceCheck": { "exemptTools": ["dewey_*", "read", "grep", "glob"] }
  },
  {
    "match": { "agent": "curator" },
    "traceCheck": { "exemptTools": ["dewey_*"] }
  }
]
```

- `match` holds `agent` and/or `command` (at least one),
  each an exact, case-sensitive string; a leading `/` on
  `command` is ignored. Every key present must match.
- `name` is optional and labels the profile in reasons and
  logs; it defaults to `profiles[<index>]`.
- `traceCheck.exemptTools` is the only grant (D3) and is
  required: a profile that grants nothing is dropped.

Validation is per profile: a profile with an unknown key, a
missing or invalid `match`, or an invalid grant is dropped
with a warning that names it; the remaining profiles and the
rest of the file stay in force. This departs from the
whole-file rejection convention (FR-057) on purpose —
rejecting the whole global file for a bad profile would also
drop `lockGuards`, failing open on the lock. For the same
reason a global file rejected for any other key (or
malformed JSON) still keeps `lockGuards: true` when it asks
for it (review round 2): the lock fails closed. A non-array
`profiles` drops only that key. At most 64 profiles are kept.

Unknown keys are rejected rather than ignored, so
`{ "match": {...}, "blockRewardHacking": false }` warns
instead of silently doing nothing.

### D3 Narrow, never disable

`exemptTools` entries are tool-name globs (`*` any run, `?`
one character, anchored, case-sensitive), bounded at 512
characters and 32 wildcards. An entry that matches any
file-mutating builtin — `bash`, `edit`, `write`, `patch`,
`multiedit`, `apply_patch` — is rejected; that also rejects
`*` and other catch-alls. A wildcard entry must also start
with a literal MCP-server prefix (`[A-Za-z0-9.-]+_`, as in
`dewey_*`), so it names one server's tools: broad globs like
`*_file` or `fs*` could match another server's file-writing
tools, which the builtin list cannot know about (review
round 2). Exact tool names are always allowed. An exempt
call skips only the
file-path trace check: reward-hacking (FR-071), directive
enforcement (FR-028), the protected-state check (FR-061),
and approve/review gates still run.

Read-only builtins (`read`, `grep`, `glob`) are not exempt
unless a profile lists them (#47's open question): their
path arguments are the trace check's evidence that reasoning
preceded the read, and glob-form reasoning (FR-069) covers
most bulk reads. Corpus-scale tasks may list them.

### D4 Matching and inheritance

A profile applies to a session when it matches the context
of the session itself or of any ancestor, walking `parentID`
up to 8 levels. Subagent sessions (task-tool children,
review-council reviewers, auto-question's helper sessions)
carry their own agent name and no command, so without
inheritance a task's grant would vanish exactly where its
subagents do the work. A session's grant is the union of the
`exemptTools` of every applicable profile; every grant has
already passed D3, so the union stays narrow.

### D5 Global file only

Agent and command names are weak keys: any repository can
define an agent called `curator` or a command called
`dewey-distill`. Grants therefore come only from the user's
global config file. `profiles` in the project file or plugin
options (which may live in a project `opencode.json`) is
removed with one warning per source. No environment variable
is offered: JSON in the environment is error-prone, and the
global file is the user-controlled tier deployed per machine.

### D6 Guard lock

`lockGuards: true` in the global file removes
`blockRewardHacking: false` and
`requireStepReferenceInTools: false` from the project file
and plugin options tiers before resolution, with one warning
per removed key. A `mode: "repair-only"` from those tiers is
removed the same way — mode selects which hooks register, so
a committed project config cannot unregister the guards
under the lock. `true` values pass through.

Review round 2: the environment is not reliably
user-controlled — per-directory env tools (mise.toml `[env]`,
direnv `.envrc`) let a committed repository file set
variables. Under the lock, guard-disabling values from the
environment (`OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING=false`,
`OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS=false`,
`OPENCODE_SUPERVISOR_MODE=repair-only`) are ignored with a
warning too. `XDG_CONFIG_HOME` can be set the same way to
point the "global" file at a repository path, so when it
points away from `~/.config/opencode/supervisor/config.json`
(home resolved from the OS account, not `HOME`) and that
file sets `lockGuards: true`, the home-directory file is the
global tier, with a warning. To unlock, the user edits the
global file. `lockGuards` from any other tier is ignored
with a warning (a project cannot lock or unlock itself).

### D7 Observability

The identity line adds `lockGuards=<bool>` and, when present,
`profiles: <names>`. An exempt verdict's reason reads
"Tool '<t>' exempt from the file-path trace check by global
profile '<name>'". An applied exemption logs that reason once
per profile+tool pair per session (the FR-046 first-grant
precedent), so a skipped trace check is distinguishable in
the log from one that passed on merits. Warnings from D2,
D5, and D6 join the deferred bootstrap warnings.

## Risks

- A repository-defined agent or command that reuses a
  granted name gets the grant. Mitigation: grants are narrow
  (D3); gates, directives, and protected state still apply.
- A command grant persists for the session until another
  command runs, including unrelated follow-up messages.
- Runtime ordering of `command.execute.before` against the
  first tool call is assumed (the hook fires before the
  command's prompt runs); if it ever arrives later, the
  first calls simply get no grant (fail closed).

## Rollback

Remove `profiles` and `lockGuards` from the global file;
behavior returns to today's.
