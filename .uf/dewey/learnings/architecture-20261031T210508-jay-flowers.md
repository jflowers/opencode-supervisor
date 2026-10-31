---
tag: architecture
author: jay-flowers
category: pattern
created_at: 2026-10-31T21:05:08Z
identity: architecture-20261031T210508-jay-flowers
tier: draft
---

When a design mandates that two checks share one recognition lens, implement the lens once as a named helper both checks call, rather than mirroring the filter expression inline at each site. Observed in opencode-supervisor repair-trace-check-pipeline (FR-064, design D6): the trace check's findUnreferencedPath duplicated checkProtectedState's content-key lens verbatim — `Object.fromEntries(Object.entries(args ?? {}).filter(...CONTENT_ARG_KEYS...))` behind a bash-vs-lensed branch — because the design said to reuse "the same idiom". Design-mandated symmetry without a single implementation drifts silently: a shared key-list constant bounds vocabulary drift, but the filter mechanics and the bash-branch shape can diverge on later edits with no owner noticing. The tell is a design sentence saying a new check "uses the same idiom" an existing check uses — that sentence is the extraction signal; name the idiom as a function (e.g. operationalArgs(toolName, args)) and cite it from both call sites.
