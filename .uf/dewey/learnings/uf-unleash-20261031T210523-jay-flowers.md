---
tag: uf-unleash
author: jay-flowers
category: gotcha
created_at: 2026-10-31T21:05:23Z
identity: uf-unleash-20261031T210523-jay-flowers
tier: draft
---

A handoff message claiming "tree clean" is stale by dispatch time — always re-run `git status --short` when resuming a review pipeline, and again after the dispatch returns. On opsx/repair-trace-check-pipeline, an orchestrator handoff declared the tree clean at HEAD 3b9c875, but during the 14-minute code-review dispatch window a parallel session began actively implementing an unrelated next-version feature (untracked src/arg-repair.ts plus modifications to index.ts, src/config-file.ts, src/directives.ts, with file mtimes minutes old and PLUGIN_VERSION bumped ahead of package.json). A base-mode capture_review_diff reviews committed state only, so the approving verdict correctly covers HEAD exactly — but downstream staging steps that run `git add .` (e.g. /uf.finale's uf_finale_stage) would sweep the unreviewed in-flight work into the reviewed PR, and a version lockstep test fails on the dirty tree. Detection signals: untracked files outside the feature dir, mtimes newer than the handoff timestamp, and a version constant diverging from package.json.
