---
tag: content-pipeline
author: jay-flowers
category: pattern
created_at: 2026-10-31T18:18:17Z
identity: content-pipeline-20261031T181817-jay-flowers
tier: draft
---

In jflowers/opencode-supervisor, a change that modifies the shared audit technique (src/stripper.ts survival rules, src/auditor.ts invariant semantics) must make an explicit affected/unaffected call for the second distribution artifact, skills/reasoning-auditor/skill.md, in its proposal's Docs or Out-of-scope bullets. The 2.5.0 release set the tracking precedent (CHANGELOG: 'The standalone skill tracks the middleware: 1.0.0 → 1.1.0' when the technique changed), but parity only happens when a change assesses the skill deliberately — proposals that enumerate only README/CHANGELOG/AGENTS.md leave it silently unexamined. Curator check: when a diff changes stripper or auditor behavior, grep the change's proposal for 'skill'; absent a mention, flag the missing disposition. It can be a one-line Out-of-scope note when the skill is genuinely unaffected (e.g., the skill has no trace ledger or tool guard, so trace-semantics changes do not map to it).
