# Proposal

## Why

The plugin is expanding beyond its origin. The locked roadmap adds an
agent console (self-serve tools such as `remind_me`, Change B and D)
and an engineer console (directive files, Change C) on top of the
existing automated reasoning-audit loop. The name
`opencode-reasoning-audit` describes one of three pillars. Renaming
to `opencode-supervisor` before those surfaces land avoids renaming
mid-expansion and gives the repo a name that matches what it is
becoming: a supervision plane for agent sessions. The VentureBeat
article that inspired the project remains the documented origin of
the audit module.

## What Changes

- **BREAKING**: the plugin id and config key change from
  `opencode-reasoning-audit` to `opencode-supervisor`; version
  becomes 2.0.0.
- **BREAKING**: all `OPENCODE_AUDITOR_*` environment variables are
  renamed to `OPENCODE_SUPERVISOR_*` (MODEL, VARIANT,
  MAX_REGENERATIONS, STRIP_MODE, BLOCK_REWARD_HACKING,
  REQUIRE_STEP_REFERENCE_IN_TOOLS, MEMO_MAX_SOLVED_ITEMS,
  MEMO_MAX_CRITIQUES). Clean cut: no legacy aliases are read.
- Changed: user-visible message prefix `[reasoning-audit]` becomes
  `[supervisor]`; the auditor side-session title reflects the new
  name.
- Changed: `package.json` name/description/keywords; GitHub repo
  renamed (old URLs redirect); `origin` remote updated.
- Changed: docs rewritten around the supervision identity — README
  (with a migration table), AGENTS.md, CHANGELOG 2.0.0 entry.
  Verified: `skills/reasoning-auditor/skill.md` is self-contained
  with no middleware or repo references; no update was required.
  The skill keeps its name: standalone, it is a reasoning auditor.
- Unchanged: all behavior, hooks, module structure, tests semantics;
  historical artifacts (`openspec/changes/audit-supervisor/`,
  `.uf/`) are not rewritten.

## Capabilities

### New Capabilities

- `supervisor-config`: the plugin's identity and configuration
  surface — id, version, environment-variable names, and the
  clean-break migration contract for 1.x users.

### Modified Capabilities

(none — no requirement in `reasoning-audit`, `tool-guard`, or
`supervisor-memo` changes semantics; their config-precedence
wording is name-agnostic)

## Impact

- **Code**: `index.ts` (id, config key, version, prefixes, env
  vars), `src/auditor.ts` (MODEL/VARIANT env vars),
  `test/audit.test.ts` (references).
- **Docs**: `README.md`, `AGENTS.md`, `CHANGELOG.md`, skill
  cross-refs.
- **Users**: must migrate environment variables (table in README);
  old repo URLs redirect to the new name.
- **Out of scope**: any behavior change, the agent-console tools
  (Change B/D), directives (Change C), and rewriting historical
  spec artifacts.

## Constitution Alignment

Assessed against the Unbound Force org constitution.

### I. Autonomous Collaboration

**Assessment**: PASS

The rename keeps outputs self-describing: the new id, prefixes, and
README state what the middleware is. Documentation and spec
artifacts carry the migration story so future agents can discover
it without archaeology.

### II. Composability First

**Assessment**: PASS

Standalone functionality is preserved — the skill keeps its name
and works without the middleware; the middleware adds no new
dependencies. Renaming is identity, not coupling.

### III. Observable Quality

**Assessment**: PASS

The 2.0.0 version, CHANGELOG entry, and README migration table make
the breaking config rename machine- and human-discoverable.
Provenance (the article as origin of the audit module) is retained
in the README.

### IV. Testability

**Assessment**: PASS

No behavior changes; the existing suite covers the renamed surface
(config precedence, prefixes). Tests are updated in the same change
and must pass under both runtimes.

### V. Security by Default

**Assessment**: PASS

The rename touches no dependencies, input validation, or
privileges, and removes no guard. No new attack surface is
introduced.
