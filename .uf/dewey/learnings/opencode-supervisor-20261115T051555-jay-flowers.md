---
tag: opencode-supervisor
author: jay-flowers
category: gotcha
created_at: 2026-11-15T05:15:55Z
identity: opencode-supervisor-20261115T051555-jay-flowers
tier: draft
---

When an idle/session-lifecycle hook inspects only the last message, prefer the OpenCode SDK's bounded `session.messages({ query: { limit } })` over an unbounded fetch. The full `/session/{id}/message` response carries every message and part (including large tool outputs), so fetching it on every idle turn costs O(transcript) per turn and compounds over the long sessions this middleware supervises. Also dedupe on a value you already have before paying for the fetch, because both `session.idle` and `session.status` idle fire per turn.
