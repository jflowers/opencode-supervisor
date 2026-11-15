# Tasks

## 1. Directive parsing for gate rules

- [x] 1.1 Add `ApproveRule`/`ReviewRule` types and
      `normalizeApproveRules`/`normalizeReviewRules` to
      `src/directives.ts`; wire both into `parseDirectives`
      and `parseOptionsDirectives` (validation: approve needs
      one of tool/path/pattern, review needs path; per-kind
      MAX_RULES_PER_DIRECTIVE slice with drop warnings;
      invalid rules skip with warnings). Verify: new
      module tests in `test/directives.test.ts` parse
      approve/review fences, options tuples, invalid-rule
      warnings, and per-kind bounds.
- [x] 1.2 Extend `Directive` with optional `approve`/`review`
      arrays and confirm advisory rendering stays unchanged
      (gate internals never render). Verify: memo test shows
      identical advisory text for a directive with gate
      rules.

## 2. Pure gate module

- [x] 2.1 Create `src/gates.ts` with `MAX_APPROVALS`,
      `ApprovalRecord`, `CompiledGates`/`compileGates`
      (glob + regex compilation, invalid patterns
      skip-and-warn), and `matchApproveGates` (tool CI,
      path glob full/basename, pattern on raw args; returns
      matched gate key + directive id or null; gate key =
      explicit id else `<directiveId>/<ruleIndex>`).
      Verify: module tests in `test/gates.test.ts` cover
      key derivation, each matcher field, and non-matching
      calls.
- [x] 2.2 Add `parseApprovals` (JSON array shape
      `{gate, note?, expires?}`, MAX_APPROVALS most-recent
      bound, malformed entries skipped) and
      `approvalMatches` (gate equality, YYYY-MM-DD expiry
      skipping, past dates never match). Verify: module
      tests cover valid/expired/over-cap files and
      malformed entries.
- [x] 2.3 Add `evaluateReviewGates` (gate-matched paths
      must be referenced by a verified step, FR-011
      contains semantics; empty trace blocks; block reason
      names path + audit-first instruction). Verify: module
      tests cover blocked, admitted, and empty-trace cases.

## 3. Hook wiring

- [x] 3.1 In `index.ts`: compile gates at server start
      alongside `compileEnforcement`; in
      `tool.execute.before`, after the existing guard
      verdict, evaluate approve gates (two-phase: pure match,
      then fresh approvals read — ENOENT is an empty set,
      other read/parse errors fail closed with the error in
      the reason) and review gates (verified trace). Verify:
      hook-layer tests in `test/gates.test.ts` — unapproved
      block names key + instruction, recorded approval
      admits, revocation blocks on next call, malformed
      file blocks with error, absent file blocks with
      instruction.
- [x] 3.2 Add `grantedGates: Set<string>` to SessionState
      (clear on dispose); log the first grant per gate key
      (`[supervisor] gate '<key>' approved for tool
      '<tool>'`). Verify: hook test asserts exactly one log
      line across two approved calls through the same gate.
- [x] 3.3 Confirm review-gate synergy with `request_audit`:
      a review-gated call blocked on empty trace succeeds
      after a passing on-demand audit references the path.
      Verify: hook test drives request_audit then retries
      the gated call.

## 4. Docs and release

- [x] 4.1 Update README (§7.5 approve/review rule kinds +
      approvals file format and expiry semantics, §6
      approvals path, §9 trust note for the approvals file,
      §10 roadmap item complete), AGENTS.md (overview,
      structure, architecture bullets), package.json +
      index.ts version 2.4.0, CHANGELOG 2.4.0 with verified
      test counts. Verify: grep sweep — every enumeration
      of rule kinds, memo sections, and test commands
      matches the tree; both test runners green.
- [x] 4.2 File doc issues per convention (blog issue for
      2.4.0, tutorial #4 scope comment, docs-verification
      issue). Verify: issue numbers recorded in the
      Workflow follow-up section below.

## 5. Review and PR

- [x] 5.1 Run the review council (`/uf.review-council`),
      resolve any REQUEST CHANGES, and record the verdict
      and artifact path here. Verify: consolidate verdict is
      APPROVE or APPROVE WITH ADVISORIES with zero HIGH or
      CRITICAL findings.
- [x] 5.2 Open the PR `opsx/directive-gates` -> `main` and
      archive the change via the opsx archive workflow
      after merge. Record the PR number here. Verify: PR is
      open, assigned, and references this change.

## Workflow follow-up

- Archive the change after the PR merges (opsx archive
  workflow; delta specs sync to `openspec/specs/`).
- Extend tutorial issue #4 with gate authoring (approve +
  review rules, approvals file lifecycle). Done in 4.2:
  issuecomment-6405743608.
- Blog follow-up for 2.4.0: filed in 4.2 as #25. Docs
  verification backstop: #26.
- Cross-repo capabilities page: filed in review round 1 as
  unbound-force/website#331 (the 4.2 sweep missed it — the
  docs-gate convention should enumerate the website repo by
  name; noted for the convention fix).
- Older unarchived changes (agent-reminders,
  rebrand-supervisor, audit-supervisor) can be swept the
  same way as supervisor-tools was.

## Archive

Merged in PR #27; `/uf.review-council` ran before merge. Archived 2026-11-15.
