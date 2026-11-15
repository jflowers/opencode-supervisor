# Proposal

## Why

The tool guard's reward-hacking check (FR-009,
`matchRewardHackingMarker` in `src/tool-guard.ts`) substring-
matches the entire JSON-serialized argument object of every
tool call. A mention is treated as a use: writing a Markdown
note that says "never commit with `--no-verify`", or running
the `grep` tool for `.skip(` across a corpus, is blocked
exactly like `git commit --no-verify`.

Knowledge-curation sessions hit this continuously — the
material is about git and test discipline — and the only
workaround is `blockRewardHacking: false` in project config.
That disables the guard for every agent in the repository,
including ordinary development, which is where the guard
matters. Copying such a config into a development repository
silently removes the protection.

The trace check already solved the same problem for path
mentions with an argument lens (FR-064): authored content is
data, not an operation. Dewey's content sanitizer reached the
same conclusion for injection phrases (design D2, "Warn,
Don't Block"): knowledge about an attack contains the attack's
words.

## What Changes

- FR-071 (new): the reward-hacking check scans execution
  surfaces only.
  - Bash: the full argument object, unchanged.
  - Read-only builtin tools (`read`, `glob`, `grep`,
    `webfetch`, `websearch`): not scanned — they cannot commit,
    skip, or delete anything.
  - Every other tool: non-content argument values are always
    scanned (unknown and custom keys stay covered, fail
    closed). `oldString` is never scanned — removing a marker
    is the fix, not the hack. `content` and `newString` are
    scanned unless the call has no file target or every target
    is a prose document (`.md`, `.mdx`, `.markdown`, `.txt`,
    `.rst`, `.adoc`).
- The block reason and `blockedCheck` are unchanged.

## Capabilities

### New Capabilities

- `tool-guard`: FR-071 — reward-hacking scan surfaces. FR-009
  (in the archived-pending `audit-supervisor` change) keeps its
  marker set; FR-071 defines where the markers are looked for.

## Impact

- Code: `src/tool-guard.ts` only (a pure scan-surface helper
  feeding the existing marker matcher).
- Tests: `test/audit.test.ts` guard cases for both directions.
- Docs: README knob table and tool-guard section, CHANGELOG,
  AGENTS.md architecture note.
- Risk: bounded. Bash, code files, scripts, config files, and
  unknown tools keep today's coverage. The narrowed surfaces
  are prose documents, target-less content payloads (the same
  class FR-064 already treats as data), read-only queries, and
  `oldString`. The check remains a tripwire, not a sandbox:
  `git commit -n` was never caught.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

Block reasons stay structured (`blockedCheck:
'reward-hacking'`) and name the marker.

### II. Composability First

**Assessment**: PASS

No new dependency or knob; the default behavior narrows false
positives so the guard can stay on everywhere.

### III. Observable Quality

**Assessment**: PASS

Unchanged reason text and block attribution.

### IV. Testability

**Assessment**: PASS

The scan-surface helper is pure and covered by guard tests in
both directions.
