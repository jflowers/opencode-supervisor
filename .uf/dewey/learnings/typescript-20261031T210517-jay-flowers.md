---
tag: typescript
author: jay-flowers
category: gotcha
created_at: 2026-10-31T21:05:17Z
identity: typescript-20261031T210517-jay-flowers
tier: draft
---

A module-level regex with the `g` flag is shared mutable state: `matchAll` copies `lastIndex` into its iterator and `.test` advances it, so one consumer's match silently shifts every later consumer's start offset. In opencode-supervisor, a stripper survival probe (`hasPathToken`) left the cursor mid-pattern and the tool guard's next `extractPathTokens` call skipped leading tokens it was built to see. The fix (src/path-tokens.ts): keep only the pattern SOURCE as a module constant and compile a fresh `new RegExp(SOURCE, 'g')` per call (or a non-global instance for `.test`) — per-call-site compilation makes interleaved consumers unable to shift each other's offsets, at negligible compilation cost.
