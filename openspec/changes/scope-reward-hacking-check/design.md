# Design

## Context

`verifyToolIntent` builds `rawArgs = JSON.stringify(args)` and
passes it to `matchRewardHackingMarker`, which looks for
`--no-verify`, `.skip(`, `expect(true).toBe(true)`, and
`rm -rf test(s)`. Every key of every tool is scanned. The
trace check narrowed its own scan in FR-064 with
`CONTENT_ARG_KEYS` (`content`, `oldString`, `newString`), but
the reward-hacking check never got a lens.

## Goals

- Stop blocking mentions of markers in prose and read-only
  queries, so `blockRewardHacking` can stay `true` in
  knowledge-curation sessions.
- Keep today's coverage for bash, code, scripts, config, and
  unknown tools.

## Non-Goals

- Changing the marker set (FR-009) or the auditor's
  deterministic reasoning-step invariants.
- Parsing shell: a bash `grep -- "--no-verify"` still blocks.
  Use the `grep` tool.
- Parsing `apply_patch` `patchText` targets or nested edit
  arrays; those payloads stay scanned in full (fail closed).
- Per-agent or per-tool configuration (tracked in #47, #48).

## Decisions

### D1 Scan surface by tool class

- `bash`: the whole argument object, as today. The command is
  operational in full (FR-064's rule for the trace check).
- Read-only builtins — `read`, `glob`, `grep`, `webfetch`,
  `websearch` — are not scanned. They cannot mutate the
  workspace, so a marker in a query is never a hack. Exact
  name match only; MCP and plugin tools are not assumed
  read-only.
- Every other tool: D2 and D3.

### D2 Non-content keys always scanned

Every key outside `CONTENT_ARG_KEYS` is scanned, so custom and
MCP argument names (`args`, `flags`, `script`) stay covered —
the same fail-closed stance as FR-064 (review round 4: an
allowlist of operational keys let a custom tool evade a
check).

### D3 Content keys scanned unless the payload is prose

- `oldString` is never scanned: it names text being replaced.
  Removing `.skip(` from a test is the fix the guard wants.
- `content` and `newString` are scanned unless the call has no
  file target, or every target is a prose document.
- Targets: string values under path-named keys (`filePath`,
  `path`, `file`, `filename`, `target`) plus path candidates
  from `extractPolicyPaths` over the other non-content values.
  Path-named keys are read whole so extensionless targets
  (`Makefile`, `.husky/pre-commit`) count as non-prose.
- Prose: `.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`,
  case-insensitive. A shell script, test file, workflow, or
  `package.json` is not prose, so writing `--no-verify` into it
  still blocks.
- No target: a content payload with nowhere to land on disk
  (`note_save`, knowledge-store tools that use `content`) is
  data, matching FR-064.

### D4 One helper, unchanged matcher

A pure `rewardHackingScanArgs(toolName, args)` returns the
object to serialize (or `null` for read-only tools). The
marker matcher, reason text, and `blockedCheck` are unchanged.

## Risks / Trade-offs

- A custom tool that executes a `content` payload with no
  path-named target is now unscanned. Same residual class
  FR-064 accepted for the trace check; such tools are rare and
  directive `forbidPattern` rules still apply.
- Writing a marker into a Markdown file, then executing that
  file, is not caught. Markdown is not executed by any common
  tool; a script extension is not prose and stays scanned.
- Knowledge-store tools whose payload key is not `content`
  (Dewey's `store_learning` uses `information`) stay scanned.
  Exemption for those is #47's scope.

## Rollback

Revert the commit; no config, state, or data migration.
