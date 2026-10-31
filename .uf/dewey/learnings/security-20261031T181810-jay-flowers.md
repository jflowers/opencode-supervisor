---
tag: security
author: jay-flowers
category: pattern
created_at: 2026-10-31T18:18:10Z
identity: security-20261031T181810-jay-flowers
tier: draft
---

A fail-open timeout on a security check needs a per-session budget whenever the supervised party controls the wait's precondition. In opencode-supervisor's FR-067 bounded wait, the wait triggers only while pendingAudits is non-empty — and every reasoning part the agent emits fills that set, with audit latency growing with step size. An agent that keeps one audit past the 10-second bound (feasible whenever an LLM auditor model is configured) converts every would-block trace-check call into allow-after-timeout for the whole session, paying only latency and a logged warning. Fix pattern: cap timeout fail-opens per session using the codebase's existing bounding idiom (maxRegenerations / maxOnDemandAudits); after the cap, a timed-out wait blocks with an honest reason naming the still-unsettled audit, logged either way. General form: any fail-open whose trigger condition the supervised agent can manufacture on demand must be bounded, or 'rare failure window' becomes 'on-demand bypass'.
