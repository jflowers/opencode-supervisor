---
tag: security
author: jay-flowers
category: gotcha
created_at: 2026-10-31T21:05:04Z
identity: security-20261031T210504-jay-flowers
tier: draft
---

Compiling supervised-agent-controlled glob tokens into backtracking regexes requires a complexity bound at the compile site. In opencode-supervisor's FR-066 trace check, globPathToRegExp maps each `*` to `[^/]*` and joins segments into one flat anchored pattern; a wildcard-heavy token (`*.*.*.*....md`) tested against a long dot-bearing trace token drives O(n^k) backtracking that runs synchronously on the plugin process's event loop. Async bounds cannot help: the FR-067 10-second timeout is a Promise.race that never fires while the loop is blocked on synchronous CPU, so one crafted (pattern, trace-token) pair freezes every session's hooks in-process. Both inputs are agent-authored — tool arguments directly, and trace tokens via path-bearing steps the stripper deliberately preserves (FR-068) that pass deterministic-only audit under the default no-auditor-model install. Fix pattern: cap pattern-character count and token length before compiling (route over-bound tokens through the concrete substring path), apply the cap inside the shared glob compiler so every call site (including the pre-existing protected-state segmentMatches path) inherits it, and add a regression test pairing a pathological pattern with a pathological trace token asserting a bounded verdict.
