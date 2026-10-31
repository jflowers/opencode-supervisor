---
tag: spec-consistency
author: jay-flowers
category: pattern
created_at: 2026-10-31T18:18:20Z
identity: spec-consistency-20261031T181820-jay-flowers
tier: draft
---

When a spec change alters the membership semantics of shared state, the requirement that motivated the change is not the only consumer. In opencode-supervisor, changing the verified trace from passed-steps-only to passed-or-minor-failed (FR-063, repair-trace-check-pipeline) silently loosened two other capabilities that contract on the old invariant in spec text: the directive-gates review gate ("blocked unless the verified trace contains a passed step referencing that path" — its pure evaluateReviewGates checks membership, so a minor-failed step releases an engineer-authored guardrail) and supervisor-tools FR-037 ("passed focus ... appended to the verified trace"). The tell-tale symptoms: a design naming the primary consumer in the singular ("its consumer (FR-010)"), a Non-Goal asserting a sibling "keeps its current semantics" while the shared input's meaning changes under it, and a citation to an FR number that exists nowhere in the tree. Practice: before finalizing a change's Modified Capabilities, grep the entire spec tree for the shared structure's name (verified trace, SessionState field) and list every consumer whose contract is phrased in the old invariant's terms; each needs a Modified Capabilities entry plus an archive-time reconciliation note (the D10 mechanism), or an explicit tasked decision to preserve the old semantics at that consumer.
