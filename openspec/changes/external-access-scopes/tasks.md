# Tasks

## 0. Spec artifacts (FR-080..FR-089)

- [x] 0.1 proposal.md
- [x] 0.2 design.md (D1..D12, the verified `question` shape,
  risks, limitations, rollback)
- [x] 0.3 specs/external-access/spec.md delta
- [x] 0.4 tasks.md

## 1. Pure module (FR-080, FR-081, FR-083, FR-086)

- [x] 1.1 `src/external-access.ts`: `classifyToolAccess`,
  gate-neutral tools, lexical normalization, home and variable
  expansion, `findExternalPaths`
- [x] 1.2 grants: `parseExternalGrants` (bounded, fail-closed
  parse), `grantCovers` (mode, expiry, literal and glob
  coverage), `decideExternalAccess` (once grants last, reason
  text)
- [x] 1.3 `src/gates.ts`: shared `expiryActive`
- [x] 1.4 `src/tool-guard.ts`: name the grants file in the
  protected-state check
- [x] 1.5 unit tests: classification, containment (absolute,
  `~`, `$HOME`, relative, `../`, root itself, `/dev/null`),
  coverage (glob, mode, read never covers write, expiry),
  parse failures

## 2. Gate wiring and config (FR-082, FR-083, FR-088, FR-089)

- [ ] 2.1 `src/config-file.ts`: `externalAccess` schema
- [ ] 2.2 `src/guard-profiles.ts`: lock drops relaxing
  `externalAccess` values from lower tiers
- [ ] 2.3 `index.ts`: `externalAccess` through
  `resolveHookConfig` (env, lock), grants-file reader, gate in
  `tool.execute.before`, once-grant consumption, session-grant
  inheritance
- [ ] 2.4 hook tests: blocked write with actionable reason,
  passing read, strict read policy, file grant, corrupt file,
  bash conservatism, default off, repair-only, lock

## 3. Agent channel (FR-084, FR-085, FR-087)

- [ ] 3.1 `src/external-access.ts`: request preparation,
  `buildAccessQuestion`, `matchQuestionReply`,
  `renderExternalAccess`
- [ ] 3.2 `index.ts`: `request_access` tool (registered when
  enabled; side-session inert), `question` observation in
  `tool.execute.after`, memo section
- [ ] 3.3 `src/memo.ts`: optional external-access section
- [ ] 3.4 tests: request_access behavior, question-minted
  grants (once, session, deny, edited question), post-grant
  retry, once consumption, memo render, inheritance

## 4. Docs gate

- [ ] 4.1 CHANGELOG `[Unreleased]`
- [ ] 4.2 README: external-access section, knob rows, six
  console tools, limitations, test file list
- [ ] 4.3 AGENTS.md: overview, structure, architecture,
  session state, node test command
- [ ] 4.4 package.json `test:node`; both runners, typecheck,
  `verify:package`
- [ ] 4.5 documentation issue (filed by the maintainer before
  merge)

## 5. Review

- [ ] 5.1 `/uf.review-council`
