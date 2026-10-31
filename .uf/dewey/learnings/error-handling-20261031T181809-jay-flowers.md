---
tag: error-handling
author: jay-flowers
category: gotcha
created_at: 2026-10-31T18:18:09Z
identity: error-handling-20261031T181809-jay-flowers
tier: draft
---

When a coordination contract has consumers await a Set of in-flight promises, prescribe Promise.allSettled (or require the registered promises to resolve) — Promise.all turns any single rejection into every waiter's exception. Observed in opencode-supervisor repair-trace-check-pipeline (spec review iteration 2): task 5.2's literal `await Promise.race([Promise.all(pending), timeout])` prescription for the FR-067 guard wait makes a rejected audit continuation settle the race with a rejection before the timeout, throwing out of tool.execute.before — fail-closed-by-crash that contradicts the FR-005 fail-open posture the design cites. Spec-level fix: name all three wait outcomes (settled, timeout, rejection) and prescribe allSettled or a resolve-only requirement on registered continuations, with rejection treated as settled + logged.
