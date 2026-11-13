# Spec Delta

## Purpose

Supervise tool calls that reach outside the project root by
access mode (#45): external writes need an engineer-mediated
grant — a once or session grant minted from the engineer's
answer to a relayed question, or a persistent grant in an
engineer-edited file — while external reads pass by default.
The agent can ask but never grant.

## ADDED Requirements

### Requirement: FR-080 External-path detection

The supervisor SHALL detect the paths a tool call names from
its operational arguments: for bash, `command` and `workdir`;
for other tools, every string argument except `content`,
`oldString`, `newString`, and grep's `pattern`. Path-target
keys SHALL be read whole; other values SHALL be tokenized after
removing URLs. `~`, `$HOME`, and `${HOME}` SHALL expand to the
home directory and `$PWD` to the base directory; relative
paths SHALL resolve against the project directory (for bash, a
`workdir` argument); `..` SHALL collapse lexically and never
above `/`. A path SHALL be external when it lies outside every
project root (`directory`, and `worktree` unless it is `/`).
An unresolved upper-case variable path and a `~user` path SHALL
be external. `/dev/null`, `/dev/stdin`, `/dev/stdout`,
`/dev/stderr`, `/dev/tty`, and `/dev/fd/*` SHALL NOT be
external.

#### Scenario: Absolute path outside the root

- **GIVEN** project root `/work/proj`
- **WHEN** a `write` call targets `/etc/hosts`
- **THEN** `/etc/hosts` is external

#### Scenario: Home spellings

- **GIVEN** home `/home/u` and project root `/work/proj`
- **WHEN** a bash command names `~/notes.md` or
  `$HOME/notes.md`
- **THEN** `/home/u/notes.md` is external

#### Scenario: Relative paths stay inside

- **WHEN** an `edit` call targets `src/a.ts`
- **THEN** no path is external

#### Scenario: Traversal escapes

- **WHEN** an `edit` call targets `src/../../other/a.ts`
- **THEN** `/work/other/a.ts` is external

#### Scenario: The root itself is internal

- **WHEN** a `list` call targets `/work/proj`
- **THEN** no path is external

#### Scenario: Null redirection is not a path

- **WHEN** a bash command ends in `2>/dev/null`
- **THEN** `/dev/null` is not external

### Requirement: FR-081 Access classes

`read`, `glob`, `grep`, `list`, and `lsp` SHALL be read-class.
Every other tool, including bash and unknown MCP or plugin
tools, SHALL be write-class. `question`, `task`, `todowrite`,
`todoread`, `skill`, `webfetch`, `websearch`, `codesearch`,
and the plugin's console tools SHALL NOT be gated.

#### Scenario: Bash is write-class

- **WHEN** a bash command only reads `/etc/hosts` with `cat`
- **THEN** the call is classified write-class

#### Scenario: Unknown tools are write-class

- **WHEN** an MCP tool `fs_read_file` is classified
- **THEN** it is write-class

### Requirement: FR-082 External-access gate

When `externalAccess.enabled` is true, a write-class call that
names an external path with no covering grant SHALL be blocked
with a reason naming the path, the access class, the
`request_access` remedy, and the grants-file remedy. A
read-class call SHALL pass under `readPolicy: "allow"` and
SHALL be gated like a write under `readPolicy: "gate"`. The
gate SHALL run after the protected-state check (FR-061) and
before approve gates, and SHALL NOT apply to the plugin's own
console tools.

#### Scenario: Blocked external write

- **GIVEN** external access enabled and no grants
- **WHEN** a `write` call targets `/data/shared/out.json`
- **THEN** it is blocked and the reason names
  `/data/shared/out.json`, `write`, `request_access`, and
  `.opencode/supervisor/external-access.json`

#### Scenario: External read passes by default

- **GIVEN** external access enabled and no grants
- **WHEN** a `read` call targets `/data/shared/in.json`
- **THEN** it is not blocked by the external-access gate

#### Scenario: Strict read policy

- **GIVEN** `readPolicy: "gate"` and no grants
- **WHEN** a `read` call targets `/data/shared/in.json`
- **THEN** it is blocked

#### Scenario: Internal calls are untouched

- **GIVEN** external access enabled
- **WHEN** a `write` call targets `src/a.ts`
- **THEN** it is not blocked by the external-access gate

### Requirement: FR-083 Grants file

The supervisor SHALL read persistent grants from
`.opencode/supervisor/external-access.json` — a JSON array of
`{path, mode, note?, expires?}` with `mode` `read` or
`read-write` — fresh per gated call not already covered by a
session grant. Invalid JSON or a non-array SHALL block the
gated call with the error named. Malformed entries SHALL be
skipped. At most 50 entries SHALL be kept. An `expires` date
SHALL be active through the end of that day (UTC). A literal
grant path SHALL cover itself and its descendants; a glob
grant path SHALL cover a path it matches or whose ancestor it
matches. A `read` grant SHALL NOT cover a write-class call.
Agent tool calls touching the file SHALL be blocked by the
protected-state check. The plugin SHALL NOT write the file.

#### Scenario: A file grant allows the write

- **GIVEN** `[{"path": "/data/shared", "mode": "read-write"}]`
- **WHEN** a `write` call targets `/data/shared/a/out.json`
- **THEN** it is not blocked by the external-access gate

#### Scenario: A read grant never covers a write

- **GIVEN** `[{"path": "/data/shared", "mode": "read"}]`
- **WHEN** a `write` call targets `/data/shared/out.json`
- **THEN** it is blocked

#### Scenario: Expired grants do not cover

- **GIVEN** a `read-write` grant with `expires` yesterday
- **WHEN** a covered write is attempted
- **THEN** it is blocked

#### Scenario: Corrupt file fails closed

- **GIVEN** a grants file that is not valid JSON
- **WHEN** an uncovered external write is attempted
- **THEN** it is blocked and the reason names the read error

#### Scenario: The agent cannot edit grants

- **WHEN** a `write` call targets
  `.opencode/supervisor/external-access.json`
- **THEN** it is blocked by the protected-state check

### Requirement: FR-084 request_access console tool

When external access is enabled at plugin load, the supervisor
SHALL register a `request_access` tool with arguments `path`,
`mode` (`read` | `read-write`), and `justification`. A valid
request SHALL be stored pending (at most 10 per session) under
a unique id and SHALL return the exact `question` tool
arguments to relay, worded by the plugin with the resolved
absolute path and the mode. It SHALL reject an unknown mode, an
empty path or justification, an internal path, `/`, the home
directory itself, and a path already covered, each with an
actionable result. It SHALL grant nothing. In supervisor side
sessions it SHALL return an inert result.

#### Scenario: A request grants nothing

- **GIVEN** external access enabled
- **WHEN** the agent calls `request_access` for
  `/data/shared` in `read-write` mode
- **THEN** the result carries a `question` payload naming
  `/data/shared` and the write to `/data/shared/x.json` is
  still blocked

#### Scenario: Internal paths need no grant

- **WHEN** the agent requests access to `src`
- **THEN** the result says no grant is needed and nothing is
  stored

### Requirement: FR-085 Question-flow grants

On a completed `question` call, the supervisor SHALL match each
question carrying a pending request marker of the same session
whose text equals the stored question text, and SHALL decide
from the engineer's answer (`metadata.answers`, else the
output text): an answer containing `deny`, `reject`, or `no`
SHALL deny; `once` SHALL mint a once grant; `session` SHALL
mint a session grant; `always` or `persist` SHALL mint a
session grant and log the grants-file record to add. Any other
answer SHALL leave the request pending. Minted grants SHALL use
the stored request's path and mode. A question whose text
differs from the stored text SHALL mint nothing. Session grants
SHALL also apply to descendant sessions.

#### Scenario: Engineer allows for the session

- **GIVEN** a pending request `ax1` for `/data/shared`
  `read-write`
- **WHEN** the relayed question completes with answer
  `Allow for this session`
- **THEN** later writes under `/data/shared` in the session
  pass the external-access gate

#### Scenario: Edited question mints nothing

- **GIVEN** a pending request `ax1` for `/data/shared`
- **WHEN** a question carrying `ax1` but naming `/etc`
  completes with `Allow for this session`
- **THEN** no grant is minted

#### Scenario: Deny

- **WHEN** the relayed question completes with `Deny`
- **THEN** no grant is minted and the request is removed

### Requirement: FR-086 Once-grant consumption

A once grant SHALL be removed when a call it covered proceeds
past the whole guard. A call blocked for any reason SHALL NOT
consume it. When a session or file grant also covers the path,
the once grant SHALL NOT be consumed.

#### Scenario: Once means once

- **GIVEN** a once grant for `/data/shared/out.json`
- **WHEN** two writes to it are attempted
- **THEN** the first passes and the second is blocked

### Requirement: FR-087 External-access memo section

When external access is enabled and the session holds grants
or pending requests, the memo SHALL include an "External
access" section listing them, at most 6 lines.

#### Scenario: Pending request in the memo

- **GIVEN** a pending request `ax1`
- **WHEN** the memo renders
- **THEN** it lists `ax1` with its path and mode

### Requirement: FR-088 Configuration and guard lock

`externalAccess.enabled` (default `false`) and
`externalAccess.readPolicy` (default `"allow"`) SHALL resolve
through session config, `OPENCODE_SUPERVISOR_EXTERNAL_ACCESS`
and `OPENCODE_SUPERVISOR_EXTERNAL_ACCESS_READ_POLICY`, the
project file, plugin options, and the global file, in that
order. A wrong-typed value SHALL reject the file tier. When the
global file sets `lockGuards: true`, `enabled: false` and
`readPolicy: "allow"` from every other tier SHALL be ignored,
with a warning for the bootstrap tiers.

#### Scenario: The project cannot turn off a locked gate

- **GIVEN** a global file with `lockGuards: true` and
  `externalAccess.enabled: true`
- **AND** a project file with `externalAccess.enabled: false`
- **WHEN** an uncovered external write is attempted
- **THEN** it is blocked

### Requirement: FR-089 Default off

With `externalAccess.enabled` false, the supervisor SHALL NOT
register `request_access`, gate external paths, read the
grants file, observe `question` calls, or render the memo
section. In `mode: "repair-only"` none of it SHALL run.

#### Scenario: Existing users see no change

- **GIVEN** no `externalAccess` configuration
- **WHEN** a `write` call targets `/etc/hosts` with an empty
  verified trace
- **THEN** it is not blocked and the console has five tools
