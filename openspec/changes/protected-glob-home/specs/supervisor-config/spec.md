# supervisor-config

## ADDED Requirements

### Requirement: FR-108 a glob file name needs the supervisor directory

In the protected-state check (FR-061), a path whose last segment
holds glob metacharacters MUST match `approvals.json` only when the
segments before it can name the supervisor directory: there are
none, they glob-match a suffix of `opencode/supervisor`, their last
two glob-match `opencode/supervisor`, or one of them is `**`. An
exact `approvals.json` segment MUST still match in any position
(FR-107 unchanged).

#### Scenario: prose glob in a free-text argument

- **WHEN** a non-bash tool argument holds the text
  `no speckit/NNN-* or opsx/* match`
- **THEN** the call is not blocked as touching the approvals file

#### Scenario: glob spellings into the supervisor directory

- **WHEN** a path is `supervisor/*`, `.opencode/su*ervisor/*.json`,
  `**/app*.json`, or a bare `*`
- **THEN** the call is still blocked

### Requirement: FR-109 protected-state reasons point at the argument

A protected-state block reason MUST name the protected object in
words, name the argument that held it (the `<key>` argument; for
bash, the call's arguments), say that no approval or approvals entry
unblocks the call, and tell the agent to remove the path and retry
or describe it without the path. The reason MUST NOT contain a
`.opencode/supervisor` path.

#### Scenario: checkpoint data mentions the approvals file

- **WHEN** a `checkpoint` call is blocked because its `data`
  argument names the approvals file
- **THEN** the reason names the `data` argument and the approvals
  file, says no approval unblocks it, and holds no
  `.opencode/supervisor` path

### Requirement: FR-110 prose in custom-tool arguments is not tokenized

For a tool that is not an OpenCode builtin, a string argument whose
trimmed value holds whitespace MUST be checked as one whole path,
not split into path tokens, unless its key is a shell-style key
(`command`, `cmd`, `commands`, `script`, `shell`, `code`, `args`,
`argv`, `exec`). Builtins, bash, shell-style keys, and values
without whitespace MUST keep the token scan.

#### Scenario: prose mention in a custom tool

- **WHEN** a `checkpoint` call's `data` holds JSON prose naming
  `.opencode/supervisor/approvals.json` mid-sentence
- **THEN** the call is not blocked by the protected-state check

#### Scenario: whole-value path with spaces

- **WHEN** a custom tool's `target` is
  `my dir/../../.opencode/supervisor/approvals.json`
- **THEN** the call is still blocked

#### Scenario: shell-style key in a custom tool

- **WHEN** a custom tool's `command` is
  `cat .opencode/supervisor/approvals.json`
- **THEN** the call is still blocked
