# Tasks

## 1. Code rename (no behavior change)

- [x] 1.1 [P] Rename in `index.ts`: plugin id and config key →
  `opencode-supervisor`, `PLUGIN_VERSION` → `2.0.0`,
  `[reasoning-audit]` prefixes → `[supervisor]`, side-session
  title, and the six `OPENCODE_AUDITOR_*` env vars →
  `OPENCODE_SUPERVISOR_*` (FR-018, FR-019). Verify: `bun test`
  green after the matching test rename in 1.3.
- [x] 1.2 [P] Rename in `src/auditor.ts`:
  `OPENCODE_AUDITOR_MODEL` / `OPENCODE_AUDITOR_VARIANT` →
  `OPENCODE_SUPERVISOR_MODEL` / `OPENCODE_SUPERVISOR_VARIANT`
  (FR-019). Verify: auditor unit tests green under `bun test`.
- [x] 1.3 [P] Update `test/audit.test.ts` references (env var
  names, prefixes, expectations) to the renamed surface. Verify:
  no test asserts the old names; suite green.

## 2. Package and documentation

- [x] 2.1 [P] Update `package.json`: name
  `opencode-supervisor`, description and keywords for the
  supervision identity. Verify: `bun install` leaves lockfile
  consistent; `bun test` still runs.
- [x] 2.2 [P] Rewrite `README.md` around the supervision identity:
  lead with the supervision plane, the VentureBeat article as the
  origin of the audit module, renamed config tables, and a 1.x →
  2.x migration table for env vars. Verify: every documented env
  var matches the code; no stale repo URLs.
- [x] 2.3 [P] Update `AGENTS.md` project overview and structure
  for the new name. Verify: overview matches the repo identity.
- [x] 2.4 [P] Add the `CHANGELOG.md` 2.0.0 entry: rename, breaking
  env-var cut with the full old→new list, repo rename note.
  Verify: entry lists all eight renamed variables.
- [x] 2.5 [P] Verify `skills/reasoning-auditor/skill.md`
  cross-references to the middleware and repo (skill name
  unchanged, design D5). Verified: the skill is self-contained
  with no middleware or repo references; no update required.

## 3. Verification

- [x] 3.1 Run both runtimes green: `bun test` and
  `node --test test/` exit zero (CI parity per AGENTS.md).
- [x] 3.2 Grep gate: zero live matches for
  `OPENCODE_AUDITOR` / `reasoning-audit` outside intentional
  context — `openspec/changes/audit-supervisor/`, `.uf/`,
  CHANGELOG history entries, the README migration table and
  "formerly" note, the AGENTS.md "formerly" note, this change's
  own spec artifacts (they describe the rename), the unchanged
  skill name and path (design D5), and the "reasoning-audit
  loop" technique phrase (the audit loop is a pillar of the new
  identity). Verify: grep output shows only the excluded
  contexts.

## 4. Repo rename and publication

- [x] 4.1 Rename the GitHub repo (`gh repo rename
  opencode-supervisor`), update the local `origin` URL. Verify:
  `git push --dry-run` and `gh repo view` address the new name.
- [x] 4.2 File the documentation issues for this user-facing
  change before merge, naming both gate targets: this repo
  (AGENTS.md documentation gate — #6) and `unbound-force/website`
  (constitution cross-repo documentation rule — #326).
- [x] 4.3 Run `/uf.review-council` and resolve all REQUEST
  CHANGES before PR (AGENTS.md review mandate).
  Round 1 (beb882a): REQUEST CHANGES — all findings fixed in
  f563c7b. Round 2 (f563c7b): APPROVE WITH ADVISORIES;
  code-level advisories tracked in #9, stale-issue sweep
  recorded below. divisor-adversary infra-failed both rounds
  (opus endpoint down, 0 findings).
- [x] 4.4 Open the PR from `opsx/rebrand-supervisor` to `main`;
  archive the change via the opsx archive workflow after merge.

## Workflow follow-up

- Changes B (`agent-reminders`), C (`engineer-directives`), and D
  (`supervisor-tools`) build on this rename and start only after
  this PR merges.
- Content: blog issue #7 tracks the 2.0 rename announcement;
  advisory #8 tracks the deferred legacy-env detect-and-warn.
- Advisory sweep (round 2): tutorial issue #4 retitled and
  rescoped to the 2.0 config surface; code-level review
  advisories tracked in #9.
