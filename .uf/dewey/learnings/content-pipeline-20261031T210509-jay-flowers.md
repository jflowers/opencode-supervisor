---
tag: content-pipeline
author: jay-flowers
category: gotcha
created_at: 2026-10-31T21:05:09Z
identity: content-pipeline-20261031T210509-jay-flowers
tier: draft
---

A dispatched Divisor review child runs under a response-contract prohibition on creating issues (GitHub, Jira, or any tracker), so the Curator's file-on-missing checklist degrades to verify-then-emit: confirm what exists with `gh issue list` / `gh issue view`, and put the exact `gh issue create` command (title, labels, full body) in the finding's recommendation for the developer to run before merge. Observed in the review-council dispatch for opencode-supervisor 2.6.0 (opsx/repair-trace-check-pipeline): the missing per-release blog issue could only be reported with the filing command, never filed from the child session.
