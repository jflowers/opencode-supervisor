---
tag: spec-review
author: jay-flowers
category: gotcha
created_at: 2026-10-31T18:18:15Z
identity: spec-review-20261031T181815-jay-flowers
tier: draft
---

When a review-fix round amends a cross-reference enumeration that appears in parallel form across a change's artifacts (proposal Modified Capabilities, spec delta Purpose, design decision text), sweep every artifact carrying the same enumeration in the same edit — partial application leaves the normative spec artifact understating its own refinement scope. Detection signal: a fix note naming the artifact that was updated while two others repeat the same enumerated list. Observed in opencode-supervisor opsx/repair-trace-check-pipeline iteration 2: the F1 fix added FR-001 to the proposal's reasoning-audit enumeration and to design D2/D10, but the trace-check spec delta's Purpose still read "(FR-002, FR-003, FR-006)".
