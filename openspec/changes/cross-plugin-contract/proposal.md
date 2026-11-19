# Proposal

## Why

`opencode-research-harness` is a project plugin that runs beside the
globally loaded supervisor. It needs two things from the supervisor
(harness SPEC.md Part 5, E4 and E5):

- Both plugins change `output.args` in `tool.execute.before`. The
  harness adds scoping keys (`source_id`, `tags`, `tag`). When the
  supervisor's tool-arg repair runs after the harness and rebuilds a
  malformed call, `mergeArgsInPlace` replaces the whole object, so
  those keys are lost. Args cannot be changed after
  `tool.execute.before`, so only the supervisor can prevent this.
- The harness must ignore supervisor audit and repair side sessions.
  The 2026-11-18 double-load runaway created 5,062 of them. FR-099
  added a process-wide registry of side-session ids, but it is
  undocumented internal state, so the harness falls back to matching
  title prefixes.

## What Changes

- FR-104 (new): tool-arg repair keeps emitted keys the validator did
  not flag; a flagged key or a key the repair renamed is the repair's
  to change, and a kept key never makes the result invalid.
- FR-105 (new): `globalThis[Symbol.for('opencode-agent-supervisor.shared-state')].sideSessionIds`
  is a documented, stable contract for other plugins, with its
  lifetime and `session.created` ordering spelled out.

## Capabilities

### New Capabilities

- `tool-arg-repair`: FR-104 (the first requirement recorded for the
  repair pass under its own capability).

### Modified Capabilities

- `reasoning-audit`: FR-105.

## Impact

- Code: `src/arg-repair.ts` (`preserveUntouchedKeys`, applied by
  `repairToolArgs` to both tiers). No `index.ts` change: the hook
  merges `outcome.args`, which now carries the kept keys.
- Tests: `test/arg-repair.test.ts`, `test/audit.test.ts`.
- Docs: README 4.5 and new 4.8, CHANGELOG.
- Depends on `side-session-runaway-guard` (FR-099 creates the shared
  registry). This change only documents and tests it.
