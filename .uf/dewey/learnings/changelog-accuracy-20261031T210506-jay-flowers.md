---
tag: changelog-accuracy
author: jay-flowers
category: gotcha
created_at: 2026-10-31T21:05:06Z
identity: changelog-accuracy-20261031T210506-jay-flowers
tier: draft
---

Stored learnings do not enforce themselves: opencode-supervisor's 2.6.0 CHANGELOG shipped "9 new tests (303 total)" while the final diff adds 27 test() declarations (26 in test/audit.test.ts, 1 in test/gates.test.ts, zero removed) — the third occurrence of the count-staleness failure mode despite two prior learnings (changelog-accuracy-20261025T213044, changelog-accuracy-20261026T000538) documenting it from the 2.2.0 release. The "303 total" half was correct because it was re-verified against the runner; the "9 new" half was not. Reliable control: treat the delta claim and the total claim as separate assertions and verify both mechanically against the final diff at review time (count +test( lines in the diff's test files against the entry) — prose learnings alone did not stop the 2.2.0 or 2.6.0 recurrences.
