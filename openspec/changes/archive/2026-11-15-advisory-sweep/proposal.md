# Proposal

## Why

Review councils for #9, #13, #17, and #22 left advisories that
were never closed. Issue #55 re-checked them against `main` at
`e36fe68` and kept the ones still open.

Three are behavior defects:

- `remind_me` and `report` claim success when their storage cap
  resolves to 0. The tool says the entry "reappears in the
  supervisor memo" while nothing was stored, and `remind_me`
  burns a reminder id. A tool result is the agent's corrective
  signal; a false confirmation teaches the agent to rely on a
  memo entry that will never appear.
- `request_audit` is the only agent-authored console input with
  no fixed length cap. The focus text flows into the auditor
  prompt, the verified trace, and the tool result unbounded.
- Directive `forbidPath` and `when` path globs are root-anchored.
  The extractor faithfully captures `./secrets/token`,
  `~/secrets/token`, and absolute spellings, but the glob only
  matches the whole path or the basename, so an honest agent
  using the normal file-tool spelling walks past a
  directory-scoped forbid. Nested argument values (an array of
  edits) are not scanned for paths at all. The identity log
  line reports only a directive count, so the engineer cannot
  tell which directives loaded or from where.

The rest are code-hygiene items: an import cycle, duplicated
helpers and normalizers, magic literals, per-call glob
compilation, and test helpers still copied across files.

## What Changes

- FR-077 (new): console tools confirm only what they store.
  `remind_me` and `report` return a "disabled" result and store
  nothing when the resolved cap is 0 or less; `remind_me` does
  not consume an id. `buildMemo` normalizes `MemoLimits` at
  runtime so JavaScript callers passing an older limits object
  (without `maxReminders` or `maxReports`) get the defaults
  instead of an unbounded section.
- FR-078 (new): the `request_audit` focus is trimmed and capped
  at `MAX_AUDIT_FOCUS` (equal to `MAX_REPORT_TEXT`, 2000
  characters) before narrative stripping, so the auditor
  prompt, the verified trace, and the result all see the
  bounded text. A truncated focus is noted in the result.
- FR-079 (new): directive path matching is spelling-proof and
  its loading is observable.
  - `forbidPath` and `when` path globs match a candidate when
    they match the whole path or any slash-boundary suffix of
    it (the basename is the shortest suffix). `./`, `../`,
    `~/`, and absolute spellings therefore match a relative
    glob; a glob that starts with `/` still anchors at the
    filesystem root.
  - Path candidates for those two rule kinds also come from
    string values nested inside array and object arguments,
    bounded in depth and count.
  - Directive files are read in name order up to
    `MAX_DIRECTIVE_FILES` (25); files past the cap are never
    read or parsed and produce one summary warning.
  - The identity log line names each loaded directive with its
    source (`<id>.md` or `options`).
- Hygiene, no behavior change:
  - One `PLUGIN_ID` constant (`src/plugin-id.ts`) replaces the
    four `'opencode-supervisor'` literals.
  - `SolvedItem`, `CritiqueRecord`, and a shared
    `takeMostRecent` move to `src/records.ts`, breaking the
    `memo.ts` ↔ `console.ts` cycle and replacing the copies of
    "keep the most recent N" in reminders, reports, and memo.
    `buildMemo` applies each cap once.
  - Directive rule normalizers collapse into one generic
    normalizer; file and options parsing share one build step;
    a `matchesPaths` helper serves enforcement and triggers.
  - Trigger globs compile once at server start
    (`compileTriggers`).
  - Truncation notes interpolate `MAX_REMINDER_TEXT_LENGTH` and
    `MAX_REPORT_TEXT`.
  - `recall` reads state with `peek`.
  - Test helpers (`toolContext`, `completedReasoningPart`, the
    env-name list and env isolation) move to `test/mocks.ts`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `supervisor-tools`: FR-077 (cap-0 honesty for `remind_me`
  and `report`, runtime limit normalization) and FR-078
  (`request_audit` focus cap).
- `engineer-directives`: FR-079 (path anchoring, nested
  arguments, read-time file cap, load provenance logging).

## Impact

- Code: `index.ts` (console tool bodies, directive loading,
  identity line, trigger call site), `src/memo.ts`,
  `src/console.ts`, `src/reminders.ts`, `src/directives.ts`,
  `src/tool-guard.ts` (enforcement path source),
  `src/auditor.ts` and `src/plugin-log.ts` (constant only), and
  two new leaf modules: `src/records.ts`, `src/plugin-id.ts`.
- Tests: new cases for every FR-077..FR-079 scenario, the
  `maxOnDemandAudits` session override, and the anchoring
  spellings; helper consolidation in `test/mocks.ts`.
- Docs: CHANGELOG, AGENTS.md (structure, new modules), README
  (directive glob anchoring, console cap-0 behavior).
- Risk: suffix matching widens `forbidPath` and `when` coverage.
  A relative glob such as `config/*.json` now also matches
  `vendor/x/config/a.json`. For a forbid rule this errs toward
  blocking; for a trigger it surfaces an advisory early. A
  leading `/` restores root anchoring.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

Tool results stop overclaiming: a disabled surface says so,
so the agent never plans around a memo entry that does not
exist.

### II. Composability First

**Assessment**: PASS

No new dependency or knob. The new modules are pure leaves
that import nothing from their consumers.

### III. Observable Quality

**Assessment**: PASS

The identity line names loaded directives and their sources;
skipped directive files produce a warning.

### IV. Testability

**Assessment**: PASS

Every new `src/` function is pure and directly tested; the
anchoring regressions are pinned by tests in both directions.
