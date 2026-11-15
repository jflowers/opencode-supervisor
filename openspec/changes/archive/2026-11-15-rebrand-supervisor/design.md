# Design

## Context

See proposal.md for motivation. The roadmap (Changes B–D) adds two
consoles onto the supervision plane: self-serve agent tools and
engineer directives. Today every user-visible string says
`reasoning-audit` or `OPENCODE_AUDITOR_*`. This change is the
mechanical rename that precedes the expansion so no new surface
ever ships under the old name. The codebase is small (one entry
file, three pure modules, two test files), so a clean cut is cheap
now and expensive later.

## Goals / Non-Goals

**Goals:**

- Every live user-visible string (id, config key, env vars,
  prefixes, package identity, repo name) says `supervisor`.
- Zero behavior change; the full test suite passes unmodified in
  semantics under both runtimes.
- A migration path users can follow from the README alone.
- Historical artifacts stay byte-identical (audit trail).

**Non-Goals:**

- Any functional change (tools, directives, memo behavior).
- Reading legacy env vars or config keys (no alias layer).
- Renaming `skills/reasoning-auditor/` — standalone, the skill is
  accurately named for its technique.
- Rewriting `openspec/changes/audit-supervisor/` or `.uf/`.

## Decisions

### D1: Rename before the expansion

Changes B–D each add config (MEMO_MAX_REMINDERS, directive
options) and user-visible tools. Renaming first means those land
as `OPENCODE_SUPERVISOR_*` from their first commit; no surface is
born with a deprecated name. Alternative — rename last — rejected:
two consoles' worth of strings would need a second pass and the
README would document names scheduled to die.

### D2: Clean cut, no aliases (BREAKING, 2.0.0)

`OPENCODE_AUDITOR_*` variables stop being read entirely. Major
version plus a README migration table is the contract. Dual-read
(accept both prefixes) was rejected: it doubles the config surface
indefinitely, complicates FR-019's precedence story, and the
audience (self-configured plugin users) is well served by a table.

### D3: Repo rename via GitHub redirect

`gh repo rename opencode-supervisor` preserves all URLs (web, git,
issues) via redirect. Local `origin` is updated to the new URL so
pushes don't depend on the redirect. The doc issue and PR are
filed after the rename so links land on the final name.

### D4: Message prefix and side-session title

Critique prefix `[reasoning-audit]` → `[supervisor]`; side-session
title `reasoning-audit @ model (variant)` →
`supervisor-audit @ model (variant)`. Short, stable, and accurate
for the audit loop regardless of future consoles.

### D5: Skill keeps its name, cross-refs verified

`skills/reasoning-auditor/skill.md` stays (its technique is
reasoning auditing; the middleware is what broadens). Verified:
the skill is self-contained with no references to the middleware
or repo, so no cross-reference update was needed.

## Risks / Trade-offs

- **User breakage on env vars** — accepted, mitigated by the
  migration table, CHANGELOG entry, and major version.
- **Stale external links** — GitHub redirects cover them; the
  README states the rename.
- **Missed references** — mitigated by a grep gate task (zero live
  `OPENCODE_AUDITOR` / `reasoning-audit` matches outside
  historical artifacts) before commit.

## Constitution Alignment

Referenced from proposal.md (all PASS). Notably III (Observable
Quality): version, changelog, and migration table make the rename
discoverable; IV (Testability): renamed config surface remains
covered by the precedence tests under both runtimes.
