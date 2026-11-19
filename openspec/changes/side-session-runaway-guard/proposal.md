# Proposal

## Why

On 2026-11-18 an adlc-research session froze. In 73 minutes the
supervisor created 5,062 `supervisor-audit @ …` side sessions,
peaking near 100 a minute. Every surviving audit prompt carried
the auditor's own instructions as its "Session goal", so audits
were auditing audits. None of the auditor replies completed, so
none of the side sessions were deleted.

The plugin was loaded twice for that project: once as the npm
package (global config) and once as the local checkout (project
`opencode.json`). Self-suppression lives in a module-scoped
`auditorSessionIds` set, so each copy saw the other's side
sessions as ordinary supervised sessions. Three more gaps turned
that into a runaway:

- the auditor side session runs as a full agent with every tool
  (7,811 `read` calls, plus `glob` and `bash`), so one audit
  produces many reasoning parts, each audited again;
- the audit prompt has no timeout, so a stuck auditor never ends;
- nothing caps how many audits run at once.

## What Changes

- FR-099 (new): side-session self-suppression is shared by every
  copy of the plugin in one process, and a session whose title
  marks it as a supervisor side session is suppressed even when
  another copy (any version) created it.
- FR-100 (new): auditor and repair side sessions are prompted
  with every tool disabled.
- FR-101 (new): the auditor prompt is bounded by a timeout; on
  timeout the side session is aborted and deleted and the audit
  fails open.
- FR-102 (new): at most a fixed number of auditor side sessions
  run at once per process; an audit over the cap fails open
  without creating a session.
- FR-103 (new): a second copy of the plugin loaded for the same
  directory logs one warning naming the duplicate load.

## Capabilities

### Modified Capabilities

- `reasoning-audit`: FR-099..FR-103.

## Impact

- Code: `index.ts` (`createInvokeModel`, `createRepairInvoker`,
  the side-session registry, the `event` hook, plugin startup).
- Tests: `test/audit.test.ts`.
- Docs: CHANGELOG, README troubleshooting.
- Risk: an audit that legitimately needs more than the timeout
  now fails open. Fail-open is the existing contract (FR-005).
