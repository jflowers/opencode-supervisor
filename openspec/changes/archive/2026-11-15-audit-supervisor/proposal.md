# Proposal

## Why

The plugin cannot run: `index.ts` targets an OpenCode plugin API that
does not exist in any current build (`onMessageUpdated`,
`onToolExecute`, `session.injectMessage`, `session.regenerate`,
`session.provider.complete` were verified absent from
`@opencode-ai/plugin@1.18.35`). Separately, the 2026-10-08 "Agent
thought monitoring and interruption" session developed approaches for
supervising agent reasoning (event observation + steer injection +
interrupt; dynamic system-prompt context) that map directly onto real
public-API hooks. Rebuilding now converts a non-functional plugin
into a working reasoning supervisor and adopts those ideas within
the public API's limits.

## What Changes

- **BREAKING**: Rewrite the `index.ts` hook layer onto the real
  `@opencode-ai/plugin` Hooks API: `event`, `chat.message`,
  `tool.execute.before`, `tool.execute.after`, and
  `experimental.chat.system.transform`. The nonexistent lifecycle
  hooks and their message-injection/regeneration paths are removed.
- **BREAKING**: Peer-audit LLM invocation moves from the nonexistent
  `session.provider.complete` (and the `OPENCODE_AUDITOR_ENDPOINT`
  HTTP fallback, which is removed) to an auditor side session driven
  by `input.client.session.prompt`.
- New: critique delivery. A failed audit injects a steer prompt with
  the critique, bounded per session; a severe finding (reward-hack
  pattern in reasoning) triggers `session.interrupt` plus a steer.
- New: supervisor memo. The plugin appends a system-prompt section
  carrying the session goal, a solved-items log, and prior critiques,
  refreshed before each provider call.
- New: severity outcome (`minor` | `severe`) on `PeerAuditOutcome`,
  and goal context passed into the audit prompt for scope-drift
  detection.
- Changed: tool guard degrades gracefully — the
  file-path-must-appear-in-audited-steps rule no longer blocks when
  no audited reasoning exists yet for the session.
- `src/` modules stay pure and testable: `stripper.ts` unchanged,
  `auditor.ts` and `tool-guard.ts` adjusted, new `memo.ts`.

## Capabilities

### New Capabilities

- `reasoning-audit`: Event-driven observation of assistant reasoning,
  narrative stripping, deterministic invariant checks, peer audit via
  an auditor side session, and delivery of failed-audit critiques
  (steer, bounded retry, interrupt on severe).
- `tool-guard`: Verification of tool-call intent against
  reward-hacking patterns and the audited reasoning trace before
  execution, with graceful degradation when no trace exists.
- `supervisor-memo`: Maintenance and injection of a supervision
  context (session goal, solved items, prior critiques) into the
  system prompt before each provider call.

### Modified Capabilities

(none — the project has no existing specs)

## Impact

- **Code**: `index.ts` (full rewrite), `src/auditor.ts` (injected
  model invocation, severity, goal context), `src/tool-guard.ts`
  (graceful mode), `src/memo.ts` (new), `test/audit.test.ts`
  (adapted and extended).
- **Configuration**: `OPENCODE_AUDITOR_ENDPOINT` removed;
  `OPENCODE_AUDITOR_MODEL` / `OPENCODE_AUDITOR_VARIANT` retained and
  now select the auditor side session.
- **Dependencies**: regular runtime dependency on
  `@opencode-ai/plugin` (public 1.19-era hooks; `experimental.*`
  hooks acknowledged as moving targets). Amended per spike 1.4:
  package-directory plugin entries resolve imports from the repo
  root, not `.opencode/node_modules`, so the entry's
  `import ... from '@opencode-ai/plugin'` needs the package
  installed at the repo root — a peer dependency would leave it
  unresolved at load time.
- **Docs**: `README.md` rewrite, `CHANGELOG.md` entry, `AGENTS.md`
  structure section, documentation issue before merge.
- **Out of scope**: AISDK model wrapping / streaming reasoning
  observation (dev-branch V2 API only), knowledge-store (Dewey)
  lookups for solved-item recall, `skills/reasoning-auditor`
  rewrite.
