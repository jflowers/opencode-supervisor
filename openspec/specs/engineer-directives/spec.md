# engineer-directives Specification

## Purpose

Define the engineer console's first slice: project directives the
supervisor loads, enforces at the tool guard, surfaces in the memo
(always or on trigger), and audits as drift criteria — with fixed
bounds and fail-open loading.
## Requirements
### Requirement: FR-026 — Directive sources

The plugin SHALL merge directives from two sources in deterministic
order: `.opencode/supervisor/directives/*.md` files in the project
directory (sorted by filename), then the `options.directives` array
passed via tuple plugin registration. Directives from files SHALL be
identified by filename stem; options directives lacking an id SHALL
receive a generated one.

#### Scenario: Files load from the project directory

- GIVEN a project directory containing
  `.opencode/supervisor/directives/no-secrets.md`
- WHEN the plugin server initializes
- THEN the directive set contains a directive with id `no-secrets`
  whose text is the file's markdown body

#### Scenario: Options directives merge after files

- GIVEN two directive files and one `options.directives` entry
- WHEN directives load
- THEN the set orders file directives by filename first and the
  options directive last

#### Scenario: No sources means no directives

- GIVEN a project directory without a directives directory and no
  `options.directives`
- WHEN the plugin server initializes
- THEN the directive set is empty and behavior matches 2.1.0

### Requirement: FR-027 — Directive file format

A directive file SHALL be markdown whose body is the advisory text,
with an optional first `supervisor`-tagged fenced code block holding
a JSON object with optional `enforce` and `when` rule arrays. A
malformed file or invalid JSON rules block SHALL be skipped with a
logged warning, and the plugin SHALL load.

#### Scenario: Rules block parses

- GIVEN a directive file whose body is advisory text and whose
  `supervisor` fence contains `{"enforce": [{"forbidPath": ".env*"}]}`
- WHEN the file parses
- THEN the directive carries text from the body and one forbid-path
  rule

#### Scenario: Malformed file is skipped

- GIVEN a directives directory containing one file whose fenced JSON
  is invalid
- WHEN the plugin server initializes
- THEN the file is skipped, a warning is logged, and the plugin
  loads with the remaining directives

### Requirement: FR-028 — Enforcement rules

`verifyToolIntent` SHALL accept an optional compiled-enforcement
set of forbid-path globs and forbid-pattern regexes and SHALL block
a tool call whose arguments contain a matching path or pattern. The
block reason SHALL name the directive id, the matched path or
pattern, and the directive text. An empty or absent rule set SHALL
never block.

#### Scenario: Forbidden path blocks

- GIVEN a compiled enforcement set with forbid-path `.env*` on
  directive `no-secrets`
- WHEN a tool call's arguments reference the path `.env.local`
- THEN the call is blocked and the reason names `no-secrets`,
  `.env.local`, and the directive text

#### Scenario: Forbidden pattern blocks

- GIVEN a compiled enforcement set with forbid-pattern `rm\s+-rf`
  on directive `safe-cleanup`
- WHEN a tool call's stringified arguments match the pattern
- THEN the call is blocked with a reason naming `safe-cleanup` and
  the pattern

#### Scenario: Empty rules never block

- GIVEN a tool call and an enforcement set with no rules
- WHEN verifyToolIntent runs
- THEN the call is allowed and the other checks proceed unchanged

### Requirement: FR-029 — Trigger rules

A directive with `when` rules SHALL surface in the memo only after a
tool call matching a trigger (tool name, case-insensitive, or an
argument path matching the when-glob); a directive without `when`
rules SHALL always surface. Trigger evaluation SHALL record matched
directive ids in session state even when the call is blocked.

#### Scenario: Tool-name trigger surfaces a directive

- GIVEN a directive with `when: [{"tool": "bash"}]`
- WHEN a `bash` tool call occurs in a session
- THEN the directive's id is recorded as triggered and the next memo
  for that session includes the directive

#### Scenario: Path-glob trigger surfaces a directive

- GIVEN a directive with `when: [{"path": "src/legacy/**"}]`
- WHEN a tool call's arguments reference `src/legacy/module.ts`
- THEN the directive is triggered and surfaces in the memo

#### Scenario: Blocked call still triggers

- GIVEN a directive with `when: [{"tool": "bash"}]` and a bash call
  blocked by the trace check
- WHEN the block is thrown
- THEN the directive's trigger is still recorded

#### Scenario: Unconditioned directive always surfaces

- GIVEN a directive with no `when` rules
- WHEN any memo is built
- THEN the directive appears in the memo

### Requirement: FR-030 — Memo directives section

The memo SHALL include a `Directives:` section between the session
goal and reminders when any directive is active, rendering
`- <id>: <text>` lines bounded by the fixed aggregate render budget.
The section SHALL be omitted when no directive is active, and
buildMemo SHALL return null when all sections are empty.

#### Scenario: Section renders with active directives

- GIVEN one active directive `no-secrets` with advisory text
- WHEN buildMemo runs
- THEN the memo contains a `Directives:` section with the line
  `- no-secrets: <text>` between the goal and reminders sections

#### Scenario: Section omitted without directives

- GIVEN no active directives
- WHEN buildMemo runs with a goal
- THEN the memo contains no `Directives:` section

#### Scenario: Render budget bounds the section

- GIVEN active directives whose combined text exceeds 4000
  characters
- WHEN buildMemo runs
- THEN the section is truncated to the budget and notes the
  truncation

### Requirement: FR-031 — Directives as audit criteria

The peer-audit prompt SHALL include an engineer-directives section
listing directive texts when directives are loaded, and the auditor
SHALL flag steps that violate them. The audit SHALL fail open and
SHALL behave as before when no directives are loaded.

#### Scenario: Prompt includes directives

- GIVEN one loaded directive and a completed reasoning step
- WHEN runPeerAudit runs
- THEN the prompt sent to the auditor model includes an
  `Engineer directives` section containing the directive text

#### Scenario: No directives preserves the prompt

- GIVEN no loaded directives
- WHEN runPeerAudit runs
- THEN the prompt matches the 2.1.0 form with no directives section

### Requirement: FR-032 — Bounds and fail-open loading

Directive loading SHALL enforce fixed bounds — at most 20
directives, 1000 characters of text each, 10 enforce rules and 10
when rules per directive, and a 4000-character memo render budget —
dropping or truncating beyond the bounds with a logged warning.
Loading SHALL never throw: unreadable directories, unreadable files,
malformed content, and invalid rules are skipped with warnings.

#### Scenario: Directive count bound

- GIVEN a directives directory with more than 20 files
- WHEN directives load
- THEN only the first 20 by sort order load and a warning logs the
  dropped count

#### Scenario: Text truncation

- GIVEN a directive file whose body exceeds 1000 characters
- WHEN the file parses
- THEN the stored text is truncated to 1000 characters

#### Scenario: Invalid regex rule is skipped

- GIVEN a directive whose forbidPattern is not a valid regex
- WHEN rules compile
- THEN the rule is skipped with a logged warning and the remaining
  rules compile

### Requirement: Approve and review rule kinds in the fence

The supervisor fence SHALL accept two additional rule kinds
alongside `enforce` and `when`: `approve` (array of approval
gate rules) and `review` (array of review gate rules).
Loading, validation, warnings, and bounds for these kinds
SHALL follow the same fail-open pipeline as the existing
kinds. Directive options registered via `options.directives`
SHALL accept the same rule kinds. Rendering of the advisory
text SHALL NOT include gate rule internals.

#### Scenario: fence with approve rules loads
- **WHEN** a directive file's supervisor fence contains an
      `approve` array
- **THEN** the directive loads with those rules attached
      and the advisory text rides the memo as before

#### Scenario: options-registered directive carries gates
- **WHEN** a directive is registered via `options.directives`
      with `approve` rules
- **THEN** its gates are compiled and enforced identically
      to file-loaded directives

#### Scenario: advisory render unchanged by gate rules
- **WHEN** a directive carries approve and review rules
- **THEN** the rendered advisory shows the directive id and
      text without gate rule internals

### Requirement: FR-079 Directive paths match real spellings

A `forbidPath` glob (FR-028) and a `when` path glob (FR-029)
SHALL match a path candidate when the glob matches the whole
candidate or any suffix of it that starts after a `/`. Path
candidates for these two rule kinds SHALL be extracted from
top-level string arguments and from string values nested in
array and object arguments, bounded in nesting depth and
count. A glob that starts with `/` SHALL match only whole
candidates.

The loader SHALL read at most `MAX_DIRECTIVE_FILES` (25)
directive files, in name order, and SHALL NOT read or parse
files past the cap; when files are skipped it SHALL emit one
warning naming the count. The identity log line SHALL name each
loaded directive's id and source: `<id>.md` for a file
directive, `options` for a tuple-registered one.

#### Scenario: Dot-relative spelling is forbidden

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a `read` call targets `./secrets/token`
- **THEN** the call is blocked by the directive

#### Scenario: Home and absolute spellings are forbidden

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a bash call runs `cat ~/secrets/token` or
  `cat /home/dev/proj/secrets/token`
- **THEN** the call is blocked by the directive

#### Scenario: Nested argument paths are forbidden

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a tool call carries `secrets/token` only inside an
  array of objects (for example `edits[0].filePath`)
- **THEN** the call is blocked by the directive

#### Scenario: When-path globs trigger on any spelling

- **GIVEN** a directive with `when` path `src/crypto/**`
- **WHEN** an `edit` call targets
  `/home/dev/proj/src/crypto/aes.ts` or `./src/crypto/aes.ts`
- **THEN** the directive is triggered

#### Scenario: Unrelated paths still pass

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a call targets `src/secrets.ts` or `docs/secrets-faq`
- **THEN** the call is not blocked by the directive

#### Scenario: A leading slash anchors at the root

- **GIVEN** a directive with `forbidPath` `/etc/**`
- **WHEN** a call targets `vendor/etc/conf`
- **THEN** the call is not blocked by the directive

#### Scenario: Files past the read cap are not parsed

- **GIVEN** 27 directive files, two of them sorting last and
  malformed
- **WHEN** the plugin loads
- **THEN** no malformed-file warning is emitted for them
- **AND** one warning says 2 directive files were not read

#### Scenario: The identity line names loaded directives

- **GIVEN** a file directive `no-secrets.md` and a tuple
  directive with id `prefer-bun`
- **WHEN** the identity line is logged
- **THEN** it names `no-secrets (no-secrets.md)` and
  `prefer-bun (options)`

