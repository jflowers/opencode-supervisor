# Proposal

## Why

OpenCode core's `external_directory` permission is all or
nothing. The native ask prompt offers once / always / reject
with no read-versus-write distinction, and an approved path
inherits workspace defaults — `edit` defaults to `allow`, so
approving external access grants write too. Core can express a
read-only scope only through static, hand-edited config
(`external_directory` allow plus `edit` deny), never
interactively or per request. Plugins cannot change the native
prompt: `permission.asked` / `permission.replied` are
observe-only events. The interception lever a plugin does have
is `tool.execute.before` throwing — exactly what this plugin's
tool guard already does (#45).

## What Changes

- FR-080 (new): external-path detection. Operational
  arguments (the FR-064 lens) are scanned for path tokens;
  `~`, `$HOME`, and `$PWD` expand, relative paths resolve
  against the project root (bash: its `workdir`), traversal
  collapses lexically, and a path outside every project root
  is external.
- FR-081 (new): access classes. `read`, `glob`, `grep`,
  `list`, and `lsp` are read-class; every other tool,
  including bash and unknown tools, is write-class. A short
  list of tools that act on no file (`question`, `task`,
  `todowrite`, `webfetch`, ...) is not gated.
- FR-082 (new): the external-access gate. With
  `externalAccess.enabled`, a write-class call naming an
  external path with no covering grant is blocked, naming the
  path, the class, and the `request_access` remedy. Reads pass
  under `readPolicy: "allow"` (default) and are gated under
  `"gate"`. The gate runs after the protected-state check and
  before approve gates.
- FR-083 (new): the grants file
  `.opencode/supervisor/external-access.json` — persistent
  engineer grants (`{path, mode, note?, expires?}`), read
  fresh per gated call, failing closed on a read or parse
  error, bounded, with end-of-day expiry. It sits in the
  FR-061 protected directory, so the agent cannot touch it.
- FR-084 (new): a sixth console tool, `request_access`
  (`{path, mode, justification}`), registered only when the
  feature is enabled. It records a pending request and returns
  the exact `question` tool call to relay to the engineer. It
  grants nothing.
- FR-085 (new): question-flow grants. `tool.execute.after`
  observes `question` completions, matches the pending
  request, and mints a once or session grant from the
  engineer's answer. Session grants carry into descendant
  sessions.
- FR-086 (new): once grants are consumed by the first call
  they allow.
- FR-087 (new): a bounded "External access" memo section.
- FR-088 (new): `externalAccess: {enabled, readPolicy}`
  through the full precedence chain, with environment
  variables; under `lockGuards` lower tiers cannot disable it
  or relax a global `readPolicy: "gate"`.
- FR-089 (new): default off — with `enabled: false` behavior
  is unchanged (no new tool, no gate, no memo section).

## Capabilities

### New Capabilities

- `external-access`: FR-080..FR-089.

## Impact

- Code: a new pure `src/external-access.ts` (detection,
  classification, grants parse/match, request and question
  helpers, memo rendering); `src/config-file.ts` parses
  `externalAccess`; `src/guard-profiles.ts` extends the lock
  sanitizer; `src/gates.ts` exports the shared expiry check;
  `src/memo.ts` gains an optional section;
  `src/tool-guard.ts` names the grants file in the
  protected-state check; `index.ts` wires session state, the
  gate, the after-hook minting, the console tool, and config.
- Tests: `test/external-access.test.ts` for the pure module
  and the hook layer, on both runners.
- Docs: README, CHANGELOG, AGENTS.md; a documentation issue
  before merge.
- Risk: bounded. Off by default; when on, the lexical
  detector is conservative for bash (false positives block,
  and the reason names the remedy).

## Constitution Alignment

### I. Autonomous Collaboration

**Assessment**: PASS

Block reasons name the path, the access class, and both
remedies (`request_access`, the grants file); grants and
denials are logged; the memo shows active grants and pending
requests.

### II. Composability First

**Assessment**: PASS

One opt-in key; defaults unchanged; repair-only mode
registers none of it.

### III. Observable Quality

**Assessment**: PASS

Every mint, denial, and consumed once grant logs one line;
the identity line reports `externalAccess` when enabled.

### IV. Testability

**Assessment**: PASS

All rules are pure functions in `src/external-access.ts`,
covered in both directions; hook-layer tests cover the gate,
the console tool, question minting, and the memo.

### V. Security by Default

**Assessment**: PASS

The agent cannot self-grant: grants come only from the
engineer's file or the engineer's answer to a question the
plugin worded. A read grant never covers a write call; bash
is write-class; a corrupt grants file fails closed; the lock
keeps a committed project config from turning the gate off.
