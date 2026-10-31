---
tag: changelog-accuracy
author: jay-flowers
category: gotcha
created_at: 2026-10-31T21:05:13Z
identity: changelog-accuracy-20261031T210513-jay-flowers
tier: draft
---

A CHANGELOG test-count claim authored mid-change survives to the final diff wrong even when the repository already holds multiple learnings prescribing count re-verification — remembered habits do not survive test-adding review iterations. Observed in opencode-supervisor 2.6.0 (repair-trace-check-pipeline): the entry shipped "9 new tests (303 total)" while the final diff adds 27 test() blocks (26 in test/audit.test.ts, 1 in test/gates.test.ts), the fourth occurrence of this exact error class despite three prior learnings (changelog-accuracy-20261025T213044, documentation-20261025T213048, review-process-20261025T213046). The prior fix patterns all relied on the author remembering to re-count; the structural fix is to attach the count to the workflow's release task itself: the version-stamp task (the 6.2-style task) should carry a Verify line that mechanically derives the number from the diff (count added ^test( lines across changed test files) rather than restating an authored number, so review iterations that append tests invalidate the task checkbox until the count is refreshed.
