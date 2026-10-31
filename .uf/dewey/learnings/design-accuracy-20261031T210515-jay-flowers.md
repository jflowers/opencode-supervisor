---
tag: design-accuracy
author: jay-flowers
category: gotcha
created_at: 2026-10-31T21:05:15Z
identity: design-accuracy-20261031T210515-jay-flowers
tier: draft
---

A design document's risk-acceptance bullets that enumerate which checks "still apply" to an exempted tool class must be verified against each named check's actual placement in the call graph — a check can be named as a surviving mitigation while sitting inside a conditional that exempts the very class the bullet discusses. Observed in opencode-supervisor repair-trace-check-pipeline design.md D7 risk section: the console-name-collision bullet claimed "The reward-hacking, directive, and protected-state checks still apply" to a colliding name, but checkProtectedState is invoked inside the pre-existing console-tool-exempted gates block (index.ts guard condition on the registered hooks.tool map), so console-named tools skip it; only the checks inside verifyToolIntent's unconditional prefix (reward-hacking, directive enforcement) genuinely apply. Reviewer check: for every "X still applies" claim in a risk trade-off, locate X's call site and confirm it is not downstream of the exemption being accepted; exemptions expressed as early returns or as guards on shared blocks silently cover more checks than the exemption's own scope suggests.
