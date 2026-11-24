# Design

## Decisions

### D1: Skip by parent, before the bound

`createCritiqueDelivery` receives the plugin's `resolveParent`.
It is awaited before the bound check, so check-and-reserve stays
free of awaits (review iteration 2). A parented session records
the critique with `delivered: false` and returns; no slot is
spent. Rejected: steering after the child's turn ends. The parent
reads the child's last message as the result, so any extra turn
either aborts or replaces that result.

### D2: Steer target from the latest user message

`chat.message` already records the latest user message's agent
(`state.agent`, FR-072) and model (`state.modelIdentity`). A
steer uses both when known. When either is missing it reads the
session's recent messages (bounded) and takes the newest user
message's `agent` and `model`. A failed lookup sends the steer
without them (fail open, FR-005). The subagent task recovery
(FR-096) already prompts with the child's own agent and model.

## Risks

- A wrong `parentID` skips a root session's critique. The parent
  comes from session events or `session.get`, the same source
  guard profiles trust (FR-072).

## Rollback

Revert the change; delivery returns to steering every session
without agent or model.
