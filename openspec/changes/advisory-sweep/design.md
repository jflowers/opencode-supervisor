# Design

## Context

Issue #55 consolidates the review-council advisories still open
after v2.9.1. The behavior items touch the agent console
(`remind_me`, `report`, `request_audit`) and engineer-directive
matching; the hygiene items are refactors across `src/` and the
test files. All logic stays in pure `src/` modules; `index.ts`
keeps the I/O and session state.

## Goals

- Console results describe what was actually stored.
- Every agent-authored console input has a fixed length cap.
- Directive path rules match the spellings agents really use.
- The engineer can see which directives loaded, from where.
- Remove the cycle and duplication the councils flagged without
  changing behavior.

## Non-Goals

- Changing approve or review gate path matching (`src/gates.ts`
  keeps full-path-or-basename matching; a follow-up can adopt
  `matchesPaths` there).
- Changing `extractPolicyPaths`, which also feeds the
  protected-state check and the FR-071 target scan. Only the
  directive enforcement and trigger call sites read nested
  values.
- Hot reload of directives, or a configurable file cap.

## Decisions

### D1 Cap-0 honesty in the tool layer (FR-077)

The hook layer resolves the cap before storing. When it is 0
or less, `remind_me` returns
`Reminders are disabled (maxReminders is 0) — nothing was
stored.` before incrementing the id sequence; `report` returns
the same shape for `maxReports`. Text validation still runs
first, so an empty input reports the actionable error rather
than the disabled state.

### D2 Runtime limit normalization (FR-077)

`normalizeMemoLimits(limits)` returns a full `MemoLimits`:
each field that is not a finite number falls back to
`DEFAULT_MEMO_LIMITS`. `buildMemo` calls it first, so an older
JavaScript caller's object without `maxReminders` or
`maxReports` renders the default caps. Without it,
`takeMostRecent(items, undefined)` returned the whole list.

### D3 Focus cap before stripping (FR-078)

`prepareAuditFocus(raw)` in `src/console.ts` trims, rejects an
empty focus, and truncates to `MAX_AUDIT_FOCUS`
(`= MAX_REPORT_TEXT`). It runs before `stripNarrative`, so the
stripper, the auditor prompt, the verified trace, and the
result all see bounded text. A truncation note is appended to
every result produced after preparation.

### D4 Suffix matching for directive paths (FR-079)

`matchesPaths(regex, paths)` returns the first candidate whose
whole path or any slash-boundary suffix matches. The basename
is the shortest suffix, so the previous behavior is a strict
subset. Suffixes never start with `/`, so a glob written with
a leading `/` matches only the whole absolute path. Both
`evaluateEnforcement` and `matchTriggers` use it.

### D5 Nested argument values (FR-079)

`extractDirectivePaths(args)` applies the policy-path pattern
to every string value reachable through arrays and plain
objects, up to depth 4 and 256 strings. Only directive
enforcement and triggers use it; `extractPolicyPaths` stays
top-level for the protected-state lens and the FR-071 scan,
whose content-key filtering is top-level by design.

### D6 Read-time file cap and provenance (FR-079)

`loadDirectiveFiles` sorts `.md` entries, keeps the first
`MAX_DIRECTIVE_FILES` (25), and warns once with the count of
files not read. The cap sits above `MAX_DIRECTIVES` (20) so a
few malformed files do not starve the directive set. The
identity line renders
`directives: <n> [<id> (<id>.md), <id> (options), …]` through
the pure `describeDirectiveSources(loaded, fromFiles)`.

### D7 Leaf modules for shared names and records

- `src/plugin-id.ts` exports `PLUGIN_ID`; `index.ts`
  (`PLUGIN_CONFIG_KEY`, `plugin.id`), `src/auditor.ts`, and
  `src/plugin-log.ts` (`PLUGIN_LOG_SERVICE`) read it.
- `src/records.ts` holds `SolvedItem`, `CritiqueRecord`, and
  `takeMostRecent`. It imports only the `AuditSeverity` type.
  `memo.ts` re-exports the two types so existing imports keep
  working.

### D8 Directive parse pipeline

One generic `normalizeRules(raw, entry)` replaces the five
normalizers; each rule kind supplies only its per-entry
mapping. `buildDirective(id, text, rawRules, warnings)` runs
the five normalizations, records drop warnings, and returns
`null` for a directive with neither text nor rules. File and
options parsing differ only in how they derive id, text, and
raw rules, and in the skip warning they emit.

### D9 Precompiled triggers

`compileTriggers(directives)` builds, per conditioned
directive, a list of `{ tool?, pathRegex? }`. The server
compiles once; `matchTriggers(compiled, tool, argPaths)` does
no glob compilation.

## Risks / Trade-offs

- Suffix matching can over-match a relative glob that names a
  common directory (`config/*.json`). For forbid rules this is
  the safe direction; engineers who need root anchoring write a
  leading `/` with the absolute path, or rely on the protected
  project layout. Documented in the README.
- Nested scanning reads more values per call. Bounded by depth
  and count, and the regex is linear.
- A directive file that sorts past position 25 is now silently
  absent except for the summary warning. Previously it was
  parsed and, unless five or more earlier files failed, then
  dropped by the 20-directive cap.

## Rollback

Revert the commits; no config, state, or data migration.
