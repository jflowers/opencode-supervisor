# Design

## Context

The middleware owns per-session state (goal, verified steps, solved
items, critiques) and re-renders it into the system prompt every turn
via the memo transform. The agent-console pillar (locked roadmap,
Change B of four) opens that state layer to the primary agent through
plugin-registered tools. The OpenCode plugin SDK exposes
`Hooks.tool` — a map of tool definitions offered to the agent — and
`tool.schema`, a zod re-export, so tools need no new dependency.

## Goals

- Give the agent durable, self-managed reminders that survive context
  compaction through memo re-injection.
- Keep the pure-module/hook-layer split that the rest of `src/`
  follows.
- Bound every dimension the agent can write: count and text length.
- Stay inert inside supervisor side sessions.

## Non-Goals

- Conditional reminders (trigger on tool or path) — Change C's
  directive triggers own that mechanism.
- Persistence across process restarts (state stays in-process, like
  every other session datum).
- The remaining agent-console tools — Change D.
- Any change to the audit loop or tool guard.

## Decisions

### D1: Plugin-registered tools on the hook map

`remind_me` and `forget_reminder` are registered on the `tool` key of
the hooks object, so OpenCode offers them to the primary agent like
built-in tools. Rejected: memo-only push (the agent cannot initiate
anything); natural-language detection of "remember that" in messages
(fragile, false positives); chat slash-commands (user-facing, not
agent-facing).

### D2: Pure module, injected identity

`src/reminders.ts` exports pure functions; the hook layer generates
the id (`r<seq>` from a per-session counter) and the `addedAt` ISO
timestamp and passes them in. Rejected: `Date.now()` or uuid inside
the module (impure, untestable determinism, and Bun/Node crypto
divergence for no benefit).

### D3: Monotonic ids, never recycled

Ids are `r1`, `r2`, ... from a per-session sequence that increments
on every add. Forgetting does not renumber; a later add never reuses
an id. This makes ids safe to quote in the memo and in tool results
across the whole session.

### D4: Double bounding

Storage is bounded at append (keep the most recent `maxReminders`,
matching `appendBounded`) and again at render (`takeMostRecent`
semantics in the memo path). This mirrors the solved-items pattern
and keeps the memo correct even if the cap is lowered mid-session by
config changes.

### D5: Fixed truncation ceiling

Reminder text is truncated at 2000 characters, a constant, not a
config knob. Rejected: a configurable length (config sprawl for a
hygiene bound; the memo is size-sensitive and `maxReminders` already
caps count).

### D6: Side sessions get inert results

Supervisor side sessions can see plugin tools. Instead of silently
discarding their calls (which reads as success), the tools return an
inert "not available in supervisor side sessions" result and touch no
state. This matches the self-suppression philosophy of every hook.

### D7: Echo mitigates the memo gateway limitation

Tested gateways drop pushed secondary system messages (README
section 9), so the memo is not guaranteed delivery. The `remind_me`
result therefore echoes the stored text and id — the immediate
tool result is in-conversation and survives regardless. The memo is
the durable re-injection channel; the echo is the immediate one.

### D8: Version and dependency posture

Version 2.1.0 (minor, backward-compatible). Arg schemas use
`tool.schema` from `@opencode-ai/plugin`; no new dependency is added
and the lockfile is untouched.

## Risks

- **Memo never reaches the model on some gateways** — known
  limitation; mitigated by D7 (echo) and documented in README.
- **Tool-name collision with other plugins** — `remind_me` /
  `forget_reminder` are generic; accepted, since collision means two
  providers of the same affordance, not a break.
- **Reminder noise** — an agent that over-reminds dilutes the memo;
  bounded by `maxReminders` and correctable via `forget_reminder`.
- **Unbounded agent-written text** — capped by D5.

## Constitution Alignment

- **I. Autonomous Collaboration** — the surface exists to make the
  agent self-sufficient; descriptions are discoverable meta-prompts.
- **II. Composability First** — pure module, no new dependencies,
  graceful degradation without reminders.
- **III. Observable Quality** — echo, memo section, and CHANGELOG
  make the surface observable; bounds make it predictable.
- **IV. Testability** — pure module tests, mocked-ToolContext tool
  tests, memo integration tests, both runtimes.
- **V. Security by Default** — state-only writes, bounded count and
  text, inert side sessions, no weakened guards.
