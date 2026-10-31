---
tag: content-pipeline
author: jay-flowers
category: pattern
created_at: 2026-10-31T21:05:11Z
identity: content-pipeline-20261031T210511-jay-flowers
tier: draft
---

In jflowers/opencode-supervisor the per-minor-release blog issue is a review-time convention with no task-level owner: a change's release tasks gate only the in-repo docs issue and the unbound-force/website capabilities issue (the task-6.3 two-target pattern), and prior releases' blog issues (#31 for 2.5.0) were filed during the review council and then referenced in the change's release follow-up. Detection signal: when a change's final release task enumerates exactly two issue targets (docs + website), the blog cadence issue is missing — the curator sweep is the enforcement point, and the filed blog issue's number should join the docs and website numbers in the change's follow-up so /uf.finale threads all three.
