# Design

## Context

Bootstrap warnings collected in `server()` queue in
`bootstrapWarnings` and flush on the first hook, when the HTTP log
listener is reliably up (FR-055 precedent). Config files, plugin
options, and the guard lock already warn through this path.

## Decisions

### D1: Detect names, never values

`detectLegacyEnvNames(env)` returns the sorted names whose prefix
is `OPENCODE_AUDITOR_` and whose value is a non-empty string. The
value is only tested for presence, never returned or logged, so a
legacy `..._MODEL` slug or any secret-shaped value cannot leak to
the server log, and nothing can be mistaken for an alias read.

### D2: Map each name to its replacement

The warning pairs each legacy name with
`OPENCODE_SUPERVISOR_<suffix>`. `OPENCODE_AUDITOR_ENDPOINT` was
removed in 1.0 and has no replacement; it is named as removed.
Mapping by suffix (not a fixed table) also covers 1.x names the
README table never listed; the replacement may not exist, so the
message says "rename to" and points at README §10.2 rather than
promising the new name is honored.

### D3: One bounded line

One warning per plugin load, listing at most 10 names followed by
`and N more`. The environment is attacker-adjacent only in the
sense that names are host-controlled; bounding keeps a pathological
environment from producing a huge log line.

### D4: Placement

The detector and message builder live in `src/config-file.ts`
beside the other config-surface validation (pure, injected
environment). `index.ts` passes `process.env` and pushes the
message onto `bootstrapWarnings`.

## Risks

- A user who deliberately keeps 1.x variables for a 1.x install
  on the same host sees the warning on every 2.x load. Acceptable:
  the line is one per load and names the cause.

## Rollback

Remove the push in `index.ts`; the detector is unused otherwise.
