# Design

## Context

`repairToolArgs` returns a complete replacement args object and the
hook applies it with `mergeArgsInPlace` (delete every key, assign).
Both repair tiers can drop keys: the deterministic transforms rebuild
the object (and `dropNullProperties` drops null optionals), and the
repair model returns whatever object it chooses.

OpenCode 1.19 runs `tool.execute.before` hooks one plugin at a time,
awaiting each, so no other plugin changes the args while a repair is
in flight. It publishes `session.created` from inside
`Session.create`, before the HTTP response reaches the plugin that
asked for the session (`session/session.ts`), and dispatches bus
events to each plugin's `event` hook in plugin order without awaiting
them (`plugin/index.ts`).

## Decisions

### D1: Keep unflagged keys at their emitted value

A key the validator did not flag was valid as emitted, so the repair
had no reason to touch it. Its emitted value is restored whether the
repair dropped it or rewrote it. That makes the guarantee independent
of plugin order and of what the repair model returns. Rejected: keep
only keys absent from the repaired object (a model that rewrites
`tag` would still overwrite the other plugin's value).

Flagged keys come from issue paths: `$.key`, `$.key.…`, `$.key[…]`,
matched against the known key names so keys containing dots stay
unambiguous.

### D2: Renames stay dropped

A dropped key whose value now sits under a key the repair introduced
(or a flagged key) was moved, e.g. `contents` → `content`. Restoring
it would leave both.

### D3: Never undo validity

Each kept key is added only if the result still validates. A root
`anyOf` failure is reported at `$` and flags no key, so every key is
a candidate; the re-validation keeps the repair valid.

### D4: Registry contract, not a new API

The registry already exists (FR-099). The contract is its key, its
`Set<string>` shape, and its lifetime: added before the side session
is prompted, removed when it is deleted. For `session.created`, the
supervisor's `event` hook registers by title before its first
`await`, so plugins dispatched after it in the same loop see the id.
A plugin dispatched before it cannot, because the creating copy does
not know the id yet; the README tells consumers to re-check when
acting or fall back to the title prefixes. Rejected: a pending-title
set or a predicate function on the record (more surface for the same
gap; consumers can already match titles).

## Risks

- A kept key the tool's own schema rejects (e.g.
  `additionalProperties: false`, which the subset validator ignores)
  reaches the tool. That was already true when the other plugin ran
  after the repair.

## Rollback

Revert `preserveUntouchedKeys`; the README section is documentation
only.
