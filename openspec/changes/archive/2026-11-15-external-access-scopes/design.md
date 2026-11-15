# Design

## Context

`tool.execute.before` already runs, in order: tool-arg repair,
the guard (`verifyToolIntent`: reward hacking, directives, the
file-path trace check), the protected-state check (FR-061),
approve gates, and review gates. Throwing is the sanctioned
block; the reason is the model's corrective signal (FR-012).
Engineer-authored state lives in `.opencode/supervisor/`, which
the protected-state check fences off from agent tool calls, and
the approvals file shows the fresh-read, fail-closed pattern
for engineer grants (FR-044, FR-045).

OpenCode core's `external_directory` permission cannot
distinguish read from write, and plugins cannot change its ask
prompt. The confirmed decisions in #45 make the supervisor the
sole interactive gate (`external_directory: "allow"` in
`opencode.json`), pass reads and gate writes by default, keep
the agent unable to self-grant, treat bash conservatively as
write-class, and offer two grant channels: the `question` flow
(once / this session) and a persistent grants file.

### Verified: the `question` tool shape

Checked against the opencode 1.18.20 build on the development
machine and `@opencode-ai/sdk` 1.19.4 types (`QuestionInfo`,
`QuestionAnswer`):

- Arguments: `{ questions: QuestionInfo[] }`, where
  `QuestionInfo` is `{ question, header, options: [{ label,
  description }], multiple?, custom? }` — structured options,
  with `custom` (free-text answer) defaulting to allowed.
- Result: `metadata: { answers: string[][] }` (one array of
  selected labels or typed text per question), and output text
  `User has answered your questions: "<question>"="<a, b>",
  ... You can now continue with the user's answers in mind.`
  (an unanswered question renders `Unanswered`).
- The plugin cannot ask a question itself (the SDK only lists,
  replies to, and rejects them); the agent must call the tool.

The structured shape is used: the plugin words the question,
supplies fixed option labels, and sets `custom: false`. Answers
are read from `metadata.answers`, falling back to parsing the
output text; either way the answer is matched against a fixed
reply vocabulary (D7), so a typed custom answer still works
where a host ignores `custom: false`.

## Goals

- Gate writes outside the project root on an engineer grant,
  interactively and per request, with read and write scopes.
- Never let the agent grant itself access.
- Change nothing for users who do not opt in.

## Non-Goals

- Symlink resolution or filesystem probing (lexical only).
- Changing core's native ask prompt (impossible from a plugin).
- A global (per-machine) grants file; the project file is the
  persistent tier for now.
- Gating network access (`webfetch` URLs are not paths).

## Decisions

### D1 Detection: lexical, operational arguments only

`findExternalPaths(tool, args, ctx)` returns the normalized
absolute external paths a call names. Scanned values follow the
FR-064 operational lens: for bash only `command` and `workdir`
(its `description` is prose); for other tools every string
argument except the content keys (`content`, `oldString`,
`newString`) and grep's `pattern` (a regex, not a path).
Path-target keys (`filePath`, `path`, `file`, `filename`,
`target`, `workdir`) are read whole, so paths with spaces
survive. Other values are tokenized: URLs
(`scheme://...`) are removed first, the text is split on
whitespace, quotes, and shell operators (`; | & < > ( ) = ,`
and backticks), and a token is a candidate when it starts with
`/`, `~`, `$`, or `.`, or contains a `/`. `extractPolicyPaths`
runs over the same URL-stripped values and its tokens join the
candidates (it catches glued spellings such as
`host:/etc/x`).

Each candidate resolves lexically: `~` and `~/` expand to the
home directory (`~user` is treated as external, unresolved);
`$HOME` / `${HOME}` expand to home; `$PWD` / `${PWD}` to the
base directory; a relative path resolves against the base
directory — the project directory, or for bash a string
`workdir` resolved the same way. `..` pops a segment but never
above `/`, so `../x` from the root is the parent's `x` (the
shared `normalizePathToken` is not reused for containment: it
folds case and leading dots and pops `..` past the start, which
is right for protected-state matching but would turn `../x`
into an internal `x` and `/a/.proj` into `/a/proj`).

An unresolved upper-case variable (`$TMPDIR/x`) is external:
its value is inherited from the environment and unknown.
Lower-case variables (`$f/x`) are skipped: shell-local values
must be assigned in the same command (each bash call is a fresh
process), where the literal path is itself a token.

A path is internal when it equals or lies under a project root
(`input.directory`, and `input.worktree` when it is not `/`).
`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`,
`/dev/tty`, and `/dev/fd/*` are never external — redirections
to them are ubiquitous and touch no file.

### D2 Access classes

`classifyToolAccess(tool)`: `read`, `glob`, `grep`, `list`,
`lsp` are read-class; everything else is write-class, including
bash, `edit`, `write`, `patch`, `multiedit`, `apply_patch`, and
every MCP or plugin tool (unknown tools are never assumed
read-only — the FR-071 stance). Tools that act on no file are
not gated: `question`, `task`, `todowrite`, `todoread`,
`skill`, `webfetch`, `websearch`, `codesearch`, plus the
plugin's own console tools (derived from the registered tool
map, the FR-065 precedent). `task` is safe to skip because the
subagent's own tool calls pass through this gate.

### D3 Gate placement and decision

The gate runs inside the existing gate block — after the
protected-state check, before approve gates — only while the
guard allows and only for non-console tools. With
`externalAccess.enabled`:

1. No external path, or a read-class call under
   `readPolicy: "allow"` → pass (no I/O).
2. Otherwise each external path needs a covering grant from
   the session's grants (D6) — session and once grants of this
   session, session grants of ancestor sessions.
3. Still uncovered → the grants file is read fresh (D4) and
   the decision repeats over all grants. A read or parse error
   blocks with the error named (fail closed).
4. Uncovered → block: `Tool '<t>' blocked by external-access
   supervision: <class> access to <paths> outside the project
   root needs an engineer grant. Call request_access with
   {"path": "<p>", "mode": "<mode>", "justification": ...}
   and relay the question it returns, or ask the engineer to
   add {"path": "<p>", "mode": "<mode>"} to
   .opencode/supervisor/external-access.json, then retry.`
   The reason names at most five paths.

Infrastructure errors inside the gate fail closed (the FR-045
stance): once the gate has decided a call is external and
gated, an unexpected error blocks rather than dissolving. The
existing outer fail-open catch still covers everything before.

### D4 Grants file

`<directory>/.opencode/supervisor/external-access.json`, a
JSON array of `{ "path": string, "mode": "read" |
"read-write", "note"?: string, "expires"?: "YYYY-MM-DD" }`.
Read fresh per gated, otherwise-uncovered call (grants and
revocations take effect without a restart), bounded at 64 KiB
through the same single-descriptor reader as the approvals
file. Invalid JSON or a non-array is an error (fail closed);
a malformed entry (missing path, unknown mode, a path that is
not absolute after `~` / `$HOME` expansion) is skipped — fewer
grants, so still closed. At most 50 entries are kept (the most
recent). Expiry is inclusive end-of-day UTC, the approvals
rule, now shared through `expiryActive` in `src/gates.ts`.

The file sits inside `.opencode/supervisor/`, which the
FR-061 directory backstop already protects; the protected-state
check also names it explicitly (path lens and a bash
token-boundary scan for `external-access.json`), so the block
reason says which file the agent may not touch. The plugin
never writes the file — persistent grants stay engineer-edited
text, like approvals.

### D5 Coverage

`grantCovers(grant, path, accessClass, now)`: the grant must be
active (not expired), its mode must allow the class
(`read-write` covers both; `read` covers read-class only — a
read grant never covers a write call), and its path must cover
the subject. A literal grant path covers itself and every
descendant (`/data/shared` covers `/data/shared/a/b`); `/`
covers everything. A grant path with glob characters (`*`,
`?`, `[...]`) covers a subject when it matches the subject or
any ancestor of it, through the total DP matcher
`globPathMatches` (agent-authored subjects never compile into
a RegExp; one work budget per call, a drained budget covers
nothing). Matching is case-sensitive: a different-case spelling
is not covered (fails closed).

### D6 Session grants and inheritance

Question-flow grants live in session state: `externalGrants`
(lifetime `once` or `session`, at most 20, oldest dropped).
Session-lifetime grants also apply to descendant sessions
(subagents doing the session's work), resolved through the
FR-072 parent lookup, up to 8 levels, and only when the call is
not already covered — calls that need no grant never pay for
lookups. Once grants apply only in their own session: they
exist for the retried call.

### D7 request_access and the question flow

`request_access({path, mode, justification})` validates the
mode (`read` | `read-write`), resolves the path like D1
(relative to the project root), and rejects an internal path
("no grant needed"), `/` or the home directory itself (too
broad for a relayed question — the engineer can still write
it into the file), an empty justification, and a path already
covered. Justification text collapses whitespace and truncates
at 300 characters. The request is stored pending (at most 10
per session, oldest dropped) under a monotonic id `ax<n>`, and
the result carries the exact `question` tool arguments:

```json
{"questions": [{
  "question": "[supervisor access request ax1] ...",
  "header": "External access ax1",
  "options": [
    {"label": "Allow once", "description": "..."},
    {"label": "Allow for this session", "description": "..."},
    {"label": "Deny", "description": "..."}],
  "multiple": false,
  "custom": false}]}
```

The question text continues after the marker: `The agent
requests READ-WRITE access outside the project root:
/data/shared. Justification: <text>. Grant it?`

`tool.execute.after` on a completed `question` call scans its
questions for the request marker, looks up the pending request
in that session, and requires the question text to equal the
stored text (whitespace-collapsed) — a paraphrased or edited
question mints nothing, so the agent cannot get a different
path approved under a request id. The mint uses the stored
request's path and mode, never anything from the question
arguments. The reply vocabulary, case-insensitive, checked in
this order: `deny` / `reject` / `no` → DENY; `once` → ONCE;
`session` → SESSION; `always` / `persist` → PERSISTENT;
anything else (including `Unanswered`) → no decision, the
request stays pending. PERSISTENT mints a session grant and
logs the file record the engineer can add, since the plugin
never writes the grants file (D4). A decision removes the
pending request; mints and denials log one line, and the
question's output gains one `[supervisor]` line stating the
outcome.

The agent cannot self-grant: it can create pending requests and
relay questions, but only the engineer's answer — tool output
produced by the host, observed after execution — mints a grant.
`request_access` returns inert text in side sessions.

### D8 Once-grant consumption

When a call passes because of a once grant, that grant is
removed (one call per once grant, even if it covered several
paths of the call). Non-once grants are preferred when both
cover a path, so a once grant is not spent needlessly. A call
blocked for any reason — by the external gate or by a later
approve or review gate — consumes nothing: the grant is removed
only when the whole guard lets the call proceed.

### D9 Memo section

When enabled, the memo shows an "External access" section with
this session's grants (`read-write /x (session)`, `read /y
(once)`) and pending requests (`ax2: read-write /z — relay the
question from request_access`), at most 6 lines, most recent
first kept. The section appears only when it has content.
`buildMemo` takes it as an optional pre-rendered string, so
existing callers are unchanged.

### D10 Configuration and the guard lock

`externalAccess: { enabled: boolean, readPolicy: "allow" |
"gate" }`, defaults `{ enabled: false, readPolicy: "allow" }`,
resolved per use through the full chain: session plugin config
→ `OPENCODE_SUPERVISOR_EXTERNAL_ACCESS` (`true`/`false`) and
`OPENCODE_SUPERVISOR_EXTERNAL_ACCESS_READ_POLICY`
(`allow`/`gate`) → project file → plugin options → global file
→ defaults. A wrong-typed value rejects the file tier like
every other key; unknown sub-keys are ignored.

The gate is a guard, so `lockGuards` covers it: under the lock,
`externalAccess.enabled: false` and `readPolicy: "allow"` from
the project file, plugin options, environment, or session tier
are ignored with a warning (bootstrap tiers) — a committed
project config cannot turn off a gate the user's global file
turned on, nor relax a global `readPolicy: "gate"`. Values that
tighten (`enabled: true`, `readPolicy: "gate"`) pass through.

`request_access` is registered only when `externalAccess`
resolves enabled at plugin load (the static tiers); the gate
resolves per call.

### D11 Repair-only mode

`mode: "repair-only"` returns before every guard, so the gate,
the after-hook minting, the memo section, and `request_access`
(the whole tool map is removed) never run.

### D12 Default off

With `enabled: false` nothing changes: no sixth tool, no gate,
no after-hook work, no memo section, no grants-file reads. A
test pins this.

## Risks

- Bash false positives (regex slashes, `/usr/bin/env`, flags
  glued to paths are missed or over-matched). Mitigation: only
  when opted in; the reason names the remedy; persistent file
  grants cover recurring paths.
- An agent can spam `request_access`. Pending requests are
  bounded and every question reaches the engineer, who can
  deny.
- The engineer may approve a misleading justification. The
  question names the resolved absolute path and mode the grant
  will carry, worded by the plugin.

## Limitations

- Lexical containment, not symlink-resolved — the same class
  as the existing path grammar. A symlink inside the project
  pointing outside is internal to the gate (creating one with
  bash names the external target, which is gated).
- Case-sensitive: on case-insensitive filesystems a
  different-case spelling of an internal path reads as
  external (fails closed).
- The sole-gate configuration (`external_directory: "allow"`)
  suppresses core's native ask; the supervisor's block reason
  is the agent's corrective signal.
- Headless and `--auto` runs: the question flow is
  unavailable, so only file grants apply.
- Core's TUI ask prompt cannot be made mode-aware from a
  plugin.
- Unresolved command substitution (`$(...)`, backticks) and
  computed paths are not followed.

## Rollback

Set `externalAccess.enabled: false` (or remove the key);
behavior returns to today's. Removing the grants file revokes
every persistent grant.
