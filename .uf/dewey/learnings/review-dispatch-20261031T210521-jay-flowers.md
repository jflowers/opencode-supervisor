---
tag: review-dispatch
author: jay-flowers
category: pattern
created_at: 2026-10-31T21:05:21Z
identity: review-dispatch-20261031T210521-jay-flowers
tier: draft
---

On opsx/repair-trace-check-pipeline (opencode-supervisor 2.6.0), the /uf.unleash code-review step succeeded only when dispatched directly from the parent session: two prior attempts delegating the review council to a child driver session each burned their full 30-minute window before the council finalized, leaving no dispatch artifact. The direct path — capture_review_diff (once), plan_review_dispatch (validated plan), dispatch_review_runs (one call: sibling evidence + prompt building + parallel child reviewers), then consolidate_dispatch with provenance (branch, head SHA, workflow_id uf.review-council) — completed 5 reviewer runs in ~14 minutes and persisted the approving artifact durably at .uf/artifacts/dispatch/<correlation_id>.json. Delegating an orchestration-heavy step to a child session multiplies window-exhaustion risk; dispatch aggregation tools that run in the parent are the resilient path.
