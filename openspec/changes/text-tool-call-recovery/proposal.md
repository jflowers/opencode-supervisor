# Proposal

## Why

Some models (GLM 5.3 on EnMaaS so far) sometimes end a turn by
writing a tool call into the reply as plain text, for example
`<invoke name="question">…</invoke>`, instead of making it. No
tool call happens, so `tool.execute.before` never fires and
tool-arg repair never sees it. The session goes idle and the run
looks finished. In unbound-force/unbound-force#1013 two
`/uf.address-feedback` runs were lost this way, one 12 items into
18, and gh-hud recorded the run as a success (jflowers/gh-hud#9).

## What Changes

- FR-090 (new): on session idle, the supervisor reads the
  session's last assistant message and detects text shaped like
  a tool call that names a registered tool, with no tool part
  after it. Shapes: `<invoke name="…">` (also inside
  `<function_calls>`), `<tool_call>` (JSON body or a leading tool
  name), and a bare `{"name": "<tool>", "arguments": …}` object.
  Matches inside fenced code blocks or inline code are ignored.
- FR-091 (new): on detection the supervisor steers the session
  through `promptAsync` (the critique channel) with a synthetic
  message naming the tool and asking for the real call, without
  repeating the text.
- FR-092 (new): corrections are bounded to
  `textToolCall.maxPerSession` in a row (default 2). A turn that
  ends cleanly or a human-typed message resets the run. At the
  cap the session stays idle and one warning is logged.
- FR-093 (new): plugin side sessions (auditor, repair) are never
  checked; a subagent session's detection is logged, not
  corrected (its parent already has the result); one idle burst
  checks a message at most once.
- FR-094 (new): `textToolCall.enabled` (default `true`) and
  `textToolCall.maxPerSession`, through the usual precedence
  chain, with env `OPENCODE_SUPERVISOR_TEXT_TOOL_CALL` and
  `OPENCODE_SUPERVISOR_TEXT_TOOL_CALL_MAX`.
- FR-095 (new): every detection, correction, and cap is logged
  through the plugin logger; every failure path fails open.

Out of scope: running the call parsed from the text. Asking the
agent to make the call keeps the arguments, the guard, and arg
repair on their normal path.

## Capabilities

### New Capabilities

- `text-tool-call-recovery`: FR-090..FR-095.

## Impact

- Code: a pure detector module `src/text-tool-call.ts`; config
  validation in `src/config-file.ts`; idle wiring, state, and
  config resolution in `index.ts`.
- Tests: `test/text-tool-call.test.ts` (shapes, fences, unknown
  tools, ordering, cap, side sessions, config).
- Docs: README section, knob table, CHANGELOG, AGENTS.md.
- Risk: a false positive costs one extra turn with a clear
  message, bounded by the cap; detection requires a registered
  tool id outside code.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The correction names the tool and asks for the real call; the
agent keeps ownership of the arguments.

### II. Composability First

**Assessment**: PASS

One new opt-out knob, on by default; no new dependency. The steer
reuses the existing `promptAsync` channel.

### III. Observable Quality

**Assessment**: PASS

A silently lost run becomes a logged detection and a correction;
at the cap the session stays idle for the caller to notice.

### IV. Testability

**Assessment**: PASS

Detection is a pure function over text and a tool-id set, tested
in isolation; the idle path is tested through mocked clients.
