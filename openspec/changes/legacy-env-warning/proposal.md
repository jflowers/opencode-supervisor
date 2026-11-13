# Proposal

## Why

The 2.0.0 rename (FR-019) moved every environment variable from
the 1.x `OPENCODE_AUDITOR_` prefix to `OPENCODE_SUPERVISOR_` with
no aliases. A user who upgrades with 1.x variables still set gets
a silent fallback to defaults. The worst case inverts intent:
`OPENCODE_AUDITOR_BLOCK_REWARD_HACKING=false` stops working, the
tool guard re-arms, and the visible symptom (blocked tool calls)
does not name its cause.

FR-019's "Legacy variable is ignored" scenario also has no test
locking it (review-council advisory, #9).

## What Changes

- FR-076 (new): at plugin load the supervisor scans the process
  environment for names starting with `OPENCODE_AUDITOR_` and,
  when any is set, logs one warning naming each legacy variable
  with its 2.x replacement and pointing at the README migration
  table. Values are never read, logged, or applied, so FR-019's
  no-alias contract holds.
- A regression test pins FR-019's "Legacy variable is ignored"
  scenario.

## Capabilities

### Modified Capabilities

- `supervisor-config`: FR-076 adds load-time detection of legacy
  variable names. FR-019 is unchanged: legacy values stay unread.

## Impact

- Code: a pure detector and message builder in
  `src/config-file.ts`; one bootstrap-warning push in `index.ts`.
- Tests: pure detector tests, a hook-layer warning test, and the
  FR-019 legacy-ignored regression test in
  `test/config-file.test.ts`.
- Docs: README §10.2 note, CHANGELOG Unreleased entry.
- Risk: minimal. Detection reads names only; the warning rides
  the existing deferred bootstrap-warning flush (deduplicated,
  routed to the server log, never stdout).

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The warning names the replacement variable, so the fix is
actionable without reading docs.

### II. Composability First

**Assessment**: PASS

No new knob or dependency; the warning is additive.

### III. Observable Quality

**Assessment**: PASS

Turns a silent misconfiguration into one logged line.

### IV. Testability

**Assessment**: PASS

The detector is pure (environment passed in) and tested in
isolation and through the hook layer.
