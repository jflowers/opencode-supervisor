# Proposal

## Why

A live check of `opencode-research-harness` with the supervisor
(2.13.0) on opencode 1.19.0 found two false findings:

- **Injected args blamed on the agent.** The harness scopes research
  calls in `tool.execute.before`: it adds a `topic:<slug>` tag to
  `note_save`, `tag`/`source_id` to Dewey calls, and a default `path`
  to `grep`/`glob`. OpenCode stores the call input after every hook
  ran, so the agent sees those values in its own call and reasons as
  if it chose them. The auditor, which reads only the reasoning,
  then flagged them as deviations. The agent deleted notes, re-ran
  calls, and downgraded a correct claim.
- **False `approvals.json` block.** A `glob` call with pattern
  `**/*.md` under `topics/wirecheck/` was blocked as touching the
  approvals file. The protected-state check glob-matches every path
  segment against `approvals.json`, so the `**` directory segment
  matched the file name. Any path with a wildcard directory segment
  (`src/*/x.ts`) was blocked the same way.

## What Changes

- FR-106 (new): the supervisor reads per-call injected-args records
  that other plugins publish on their shared state (the harness:
  `globalThis[Symbol.for('opencode-research-harness.shared-state')].injectedArgs`)
  and lists the session's recent ones in the audit prompt, under a
  note that the agent did not write them and they are not its
  deviations. Without records the prompt is unchanged.
- FR-107 (new): in the protected-state check, a glob segment stands
  for a protected file name only as the path's last segment. Exact
  names still match anywhere; directory runs keep glob semantics.

## Capabilities

### Modified Capabilities

- `reasoning-audit`: FR-106.
- `supervisor-config`: FR-107 (protected-state check, next to FR-061).

## Impact

- Code: new `src/plugin-injected.ts`; `src/auditor.ts`
  (`runPeerAudit` takes the rendered section,
  `PLUGIN_INJECTED_ARGS_NOTE`); `index.ts` (both audit call sites);
  `src/tool-guard.ts` (`hasProtectedSegmentRun`).
- Tests: `test/plugin-injected.test.ts`, `test/audit.test.ts`,
  `test/gates.test.ts`.
- Docs: README 4.8, CHANGELOG.
- Pairs with the harness change that publishes `injectedArgs`. Each
  side works alone: no records means no section.
