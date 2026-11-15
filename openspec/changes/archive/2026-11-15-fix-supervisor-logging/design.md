# Design

## Context

The plugin executes inside the OpenCode server process, so any
stdout/stderr write lands in the user's terminal alongside the TUI.
Twenty `console.*` call sites do exactly that, and the fail-open
warning fires once per reasoning step, spraying the display. The
same plugin hardcodes `auditorModel: 'google/gemini-3.8-flash'`; no
`google` provider exists on this machine, so every audit side
session dies with `ProviderModelNotFoundError` and the audit tier
silently fails open. The SDK exposes two endpoints that fix both:
`client.app.log` (POST /log, body `{ service, level, message,
extra }`, writes to the server log) and `client.config.get`
(GET /config, merged configuration including `model` and
`small_model`).

## Goals

- Zero plugin writes to stdout/stderr.
- A working audit tier on any machine, with no provider assumptions
  baked into the code.
- Configuration users can set once per project or globally, with the
  established precedence feel (environment wins, then nearer file).
- Keep the pure-module / hook-layer split of `src/`.

## Non-Goals

- Per-session runtime model overrides (the session config tier
  stays test-only, as documented in `resolveHookConfig`).
- Log persistence, filtering, or search beyond the OpenCode server
  log's own capabilities.
- Changing audit logic, critique delivery, or the tool guard.

## Decisions

### D1: server log through `client.app.log`

A new pure module `src/plugin-log.ts` exports
`createPluginLogger(client)`, returning `{ info, warn, error }`.
Each call POSTs `{ service: 'opencode-supervisor', level, message,
extra }`. Rejected: writing our own log file (second log to
rotate, no TUI integration), `process.stderr` with a flag (still
interleaves by default), no-op logging (loses diagnostics). The
module is the first client-bound `src/` module, defensible on
unit-testability grounds — it holds only the client reference,
keeps no session state, and the client is mocked in tests — rather
than on a `createInvokeModel` precedent (that helper lives in
`index.ts`).

### D2: fire-and-forget, warn/error dedupe, info never deduped

Delivery is `client.app.log(...).catch(() => {})` — never awaited,
never rejecting, absorbing bootstrap-time refusals (FR-053).
Dedupe keys on `level:message` for warn and error only: the
fail-open warning repeats identically per step and must collapse to
one entry (FR-054), while info lines (identity, directive
triggers, gate grants) are structurally rare and stay
uncollapsed — the identity line may be retried after bootstrap, and
collapsing it would make the retry a no-op. Dedupe state is
per-logger (per plugin process).

### D3: identity line moves to the first hook

`server()` runs during plugin bootstrap, when the HTTP listener may
not be up; the old `console.log` identity line becomes a
first-hook info entry: the first hook invocation to complete
configuration resolution logs version, auditor model, and directive
count once (module flag), when the listener is reliably up
(FR-055).

### D4: config files and per-knob precedence

`src/config-file.ts` holds the pure parsing: a file may set any
subset of the hook config (model as a full `provider/model` slug —
`splitModelSlug` splits on the first slash, so multi-segment model
ids work); unknown keys are ignored; type-invalid values or
malformed JSON reject the whole file with an error string. I/O
lives in `index.ts` (`readSupervisorConfigFile`), mirroring
`readApprovals`: size-bounded via a single-descriptor read
(`openSync` once, `fstatSync` that descriptor, bound-check, then
a `readSync` loop — review round 2's `readBoundedFile`, closing
the stat-then-read TOCTOU). ENOENT is absent, anything else skips
the file and warns once through the plugin logger. Locations:
project `<dir>/.opencode/supervisor/config.json` and global
`${XDG_CONFIG_HOME ?? ~/.config}/opencode/supervisor/config.json`.
Resolution stays per-knob — each knob independently
takes the highest tier that sets it — matching the existing
environment-override semantics: session override → environment →
project file → plugin options (new `config` key on tuple options,
validated by the same pure parser) → global file → derived →
default.

### D5: derived tier from `client.config.get`, lazy and
success-memoized

When no other tier sets the auditor model, resolve
`small_model ?? model` from the merged OpenCode configuration —
better than reading `opencode.jsonc` directly (no JSONC parsing,
honors `OPENCODE_CONFIG` and XDG, single source of truth).
Derivation is deferred to first need and memoized on success only:
a bootstrap-time failure (listener down) leaves the cache empty and
the next resolution retries (FR-058). The lookup happens inside a
`buildConfig()` helper bound per `server()` call, so hooks keep
using a plain resolved `HookConfig`.

Residual (review round 5): the lookup is bounded by a 5s
timeout and a failure budget — five consecutive failures arm a
60s backoff — so a hanging endpoint can add up to 5s per
hook-blocking resolution and ~25s cumulatively before the
backoff engages. Spec-compliant with FR-058's lazy retry;
accepted over caching failures.

### D6: no model means invariants only, not a dead plugin

`AuditConfig.auditorModel` and `auditorVariant` become optional.
`pluginConfig` embeds neither. In `runPeerAudit`, after
deterministic invariants short-circuit, an unset model returns
`passed` for the step (invariants are the verification), and the
hook layer logs one warning that the LLM tier is disabled
(FR-060). This removes the hardcoded slug (FR-059) without
resurrecting it as a different machine-specific default.

### D7: variant optional end to end

`PromptBodyWithVariant.variant` is already optional in the type;
`createInvokeModel` omits the field when unset, and the side-session
title degrades to `supervisor-audit @ <model>`.
`OPENCODE_SUPERVISOR_VARIANT` remains the environment override.

## Risks / Trade-offs

- **Bootstrap ordering**: entries emitted before the listener is up
  are lost silently. Accepted: fire-and-forget is the price of
  never blocking hooks; the identity line deliberately moves to
  first-hook time. Review round 1 narrowed the window: bootstrap
  warnings (directive/config/options) queue and flush at the same
  first-hook moment. Review round 2 closed the last leak:
  `loadDirectiveFiles` no longer logs at load time either — its
  warnings join the same queue, so nothing is emitted during
  `server()`.
- **Project-file trust**: the project directory is agent-writable
  (a supervised agent could edit its own supervisor config). The
  environment tier outranks it, and config files only tune the
  supervisor, never bypass enforcement — `enforce`/`approve`/
  `review` rules still come from the directives pipeline.
  Review round 1 correction: the config files carry the guard
  toggles (`blockRewardHacking`,
  `requireStepReferenceInTools`) and the auditor model, so
  "never bypass enforcement" overstated the case. Both config
  files are therefore agent-write-protected through the tool
  guard (matching the `approvals.json` precedent); the plugin
  options tier inherits `opencode.json`'s pre-existing trust
  class — an agent that could write it could already unregister
  the plugin — and the identity line now reports the guard
  toggles and which tiers contributed, so a flipped knob is
  visible. Numeric knobs (e.g. `maxRegenerations`) stay
  uncapped by design: they are engineer-authored state, the
  same trust class as the environment tier. Review round 2 widened
  the net to match the trust class: the directives directory is
  protected the same way (its files carry the enforce/approve/
review rules). Review round 4 resharpened both lenses after a
bypass and a false-positive surface showed up: the path lens
now folds leading dots (`.opencode` ≡ `opencode`, so the
project tier matches — it had been dead code), protects the
whole `opencode/supervisor` run (ancestor spellings like
`rm -rf .opencode/supervisor` are blocked), and for non-bash
tools scans every argument key except the write/edit content
keys (`content`, `oldString`, `newString`) — content is data,
never scanned, and custom and MCP path keys like `target` stay
covered (review round 4 flagged the operational-key allowlist as
a regression of the 2.4.0 key-agnostic coverage; the content
blocklist restores it). The raw lens is bash-only and capped at 64 KiB: a
command string is an executable operation, so mentions there
are actionable, and each bash call is a fresh process, so a
cross-call `cd` cannot persist. Residuals: bash heredoc/echo
prose can false-positive; variable indirection (`cat $CFG`) is
not caught; payload keys beyond the content blocklist (`text`,
`body`, `document`, `patch`, `diff`, `edits`, `data`) are
scanned for non-bash tools and can false-positive (fail-closed,
review round 5); accepted — the same residual class as any
path-based guard.
- **Dedupe hides recurring distinct failures**: only identical
  level+message pairs collapse; new messages always surface.
  Dedupe memory is bounded (512 entries): when the cap fills and
  clears, a previously seen pair can warn again — bounded memory
  chosen over recurrence visibility.
- **Test ripple**: hook tests currently capture `console.*`; they
  move to asserting recorded `app.log` calls, and fixtures
  expecting the old hardcoded default change to the derived tier.
