---
tag: concurrency
author: jay-flowers
category: pattern
created_at: 2026-10-31T21:05:18Z
identity: concurrency-20261031T210518-jay-flowers
tier: draft
---

Pattern for coordinating fire-and-forget background work (async audit continuations) with a synchronous-looking guard (tool.execute.before): register each continuation in a per-session `pendingAudits` Set, deregister in a `finally`, and resolve the registered promise only AFTER the shared-state mutation so awaiters always re-read settled state. The waiter snapshots the set, races `Promise.allSettled(snapshot)` against a timer cleared in a `finally` (allSettled so a rejected continuation counts as settled and never rethrows into the hook), then re-runs the pure check rather than caching its verdict. Degrade on timeout via a bounded, per-session fail-open counter (configurable through the normal precedence chain) that flips to an honest block naming the still-unsettled work past the cap, and attribute block causes with a structured enum field (`blockedCheck`) instead of prose-matching free-form reasons.
