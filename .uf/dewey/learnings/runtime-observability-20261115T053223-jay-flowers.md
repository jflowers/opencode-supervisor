---
tag: runtime-observability
author: jay-flowers
category: gotcha
created_at: 2026-11-15T05:32:23Z
identity: runtime-observability-20261115T053223-jay-flowers
tier: draft
---

When a new feature consumes an already-cached shared lookup (here `fetchToolSchemas`, shared with tool-arg repair), its failure diagnostics inherit the producing feature's log wording: the only line emitted reads "tool-arg repair: tool schemas unavailable …" even when the consumer that just degraded is text tool-call recovery. Add a feature-named skip line at the consumer's early return (or pass an attribution label into the shared lookup) so operators can find the degradation by the feature that is actually disabled. Fail-open skips that are not design exclusions also belong in the user-facing "not corrected"/"not gated" list, not only in AGENTS.md, or the documented behavior claims the check ran when it never evaluated the input.
