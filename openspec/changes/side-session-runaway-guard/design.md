# Design

## Context

`auditorSessionIds` (index.ts) is a module-level `Set`. OpenCode
loads each plugin entry as its own module, so an npm copy and a
path copy hold separate sets. Every hook checks only its own set.

## Decisions

### D1: Process-wide registry

The set lives on `globalThis` under
`Symbol.for('opencode-agent-supervisor.sideSessionIds')`. Every
copy of this version (or later) in the process shares it. Older
copies do not, so D2 covers them.

### D2: Title marker

`session.created` and `session.updated` events carry the session
title. A title starting with `supervisor-audit @` or
`supervisor-repair @` registers the id in the shared set;
`session.deleted` removes it. Events reach every copy, so this
suppresses side sessions created by any version. Rejected: a
`parentID` on side sessions (would surface them as subagents in
the TUI, and FR-004 says the auditor is not parented).

### D3: No tools for side sessions

The prompt body sets `tools: { '*': false }`. OpenCode turns each
entry into a session permission rule with pattern `*`, and
`Permission.disabled` hides every tool a `*`/deny rule matches
(opencode `session/prompt.ts`, `permission/index.ts`). The audit
prompt is self-contained, so the auditor needs no tools.

### D4: Timeout and abort

`AUDIT_TIMEOUT_MS` (180 s) bounds the auditor prompt, raced the
same way the repair invoker already is. On timeout the side
session is aborted (best effort) and then deleted. A constant,
not a knob: no config surface until someone needs to tune it.

### D5: Concurrency cap

`MAX_CONCURRENT_AUDITS` (4) counts in-flight auditor side
sessions in a process-wide counter (also on `globalThis`). Over
the cap `invokeModel` rejects before `session.create`, so
`runPeerAudit` fails open (FR-005) and nothing leaks.

### D6: Duplicate-load warning

A process-wide `Map<directory, Set<moduleUrl>>` records each
copy's `import.meta.url` per directory. A second distinct URL for
the same directory logs one warning. The same URL again (an
instance reload) is not a duplicate.

## Risks

- A slow auditor model now fails open after 180 s instead of
  blocking. That is the FR-005 contract.
- Under heavy reasoning traffic, audits over the cap pass
  unaudited. Each one is logged as a fail-open.

## Rollback

Revert the commit; no stored state or config changes.
