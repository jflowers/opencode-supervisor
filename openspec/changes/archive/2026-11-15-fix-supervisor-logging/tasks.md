# Tasks

## 1. Spec artifacts

- [x] 1.1 [P] Write `proposal.md`, `design.md`,
  `specs/supervisor-logging/spec.md` (FR-052..FR-055),
  `specs/auditor-config/spec.md` (FR-056..FR-061), and this
  `tasks.md`. Verify: every scenario carries GIVEN/WHEN/THEN; RFC
  2119 wording; line length under 72.

## 2. Logging (Change B)

- [x] 2.1 [P] Implement `src/plugin-log.ts`: `createPluginLogger`
  returning `{ info, warn, error }` over `client.app.log`, service
  `opencode-supervisor`, fire-and-forget `.catch(() => {})`,
  per-logger dedupe of warn/error by `level:message`, info never
  deduped (FR-052..FR-054). Verify: module has no direct I/O and
  no console usage.
- [x] 2.2 [P] Thread the logger through `index.ts`: create it in
  `server()`, pass into `createInvokeModel`,
  `createCritiqueDelivery`, and `loadDirectiveFiles`; replace all
  twenty `console.*` sites; move the identity line to the first
  hook invocation (FR-055). Verify: `grep -n 'console\.' index.ts`
  returns nothing.

## 3. Auditor configuration (Change A)

- [x] 3.1 [P] Implement `src/config-file.ts` as a pure module:
  `SupervisorFileConfig` shape, `validateSupervisorConfig` for
  objects (unknown keys ignored, type-invalid values reject),
  `parseSupervisorConfigFile` for raw text (FR-057). Verify: module
  has no clock, randomness, or IO.
- [x] 3.2 [P] Wire file + options tiers into `index.ts`:
  `readSupervisorConfigFile` mirroring `readApprovals`
  (size-bounded, ENOENT absent, skip + warn once), project and
  XDG-global paths, `config` key on plugin tuple options, and the
  per-knob precedence chain session → env → project → options →
  global → derived → default (FR-056, FR-057).
- [x] 3.3 [P] Implement the derived tier: lazy `client.config.get`
  lookup preferring `small_model` then `model`, memoized on success
  only, inside a per-`server()` `buildConfig()` helper used by
  every hook (FR-058).
- [x] 3.4 [P] Remove the hardcoded model: make
  `AuditConfig.auditorModel`/`auditorVariant` optional, drop both
  from `pluginConfig`, omit the variant from the side-session
  prompt and title when unset, and return invariant-only outcomes
  in `runPeerAudit` when no model resolved, with one hook-layer
  warning (FR-059, FR-060). Bump `PLUGIN_VERSION` and
  `package.json` to 2.5.0.
- [x] 3.5 [P] Extend the tool guard to protected supervisor state
  (FR-061, specified in the `auditor-config` delta; glob
  semantics hardened in review round 5): policy-path extraction in
  `src/directives.ts` covers the supervisor config files, the
  directives directory, and glob metacharacters;
  `checkProtectedState` in `src/tool-guard.ts` pairs normalized
  path-token matching with a raw bash-arguments test and
  glob-segment semantics, wired into the guard in `index.ts`.
  Verify: traversal, relative-directory, and glob spellings are
  blocked in `test/gates.test.ts`.

## 4. Tests

- [x] 4.1 [P] Write `test/plugin-log.test.ts`: level mapping,
  warn/error dedupe, info never deduped, rejected deliveries never
  throw or reject, no console output (FR-052..FR-054). Verify:
  suite green under `bun test`.
- [x] 4.2 [P] Write `test/config-file.test.ts`: parse valid full
  and subset files, unknown keys ignored, malformed JSON and
  invalid types rejected with an error string, reader behavior for
  absent/oversized files via a temp directory (FR-057). Verify:
  suite green under `bun test`.
- [x] 4.3 [P] Add precedence tests: environment over project file
  over options over global file over derived; `small_model`
  preferred over `model`; failed derivation retried (FR-056,
  FR-058). Verify: suite green under `bun test`.
- [x] 4.4 [P] Update existing suites: `mockPluginInput` gains
  `app.log` and `config.get` mocks; console-capture assertions in
  `audit`, `directives`, and `gates` move to the recorded log
  entries; fixtures asserting the old hardcoded default and
  variant update to the derived tier and optional variant
  (FR-059, FR-060). Verify: `bun test` and `node --test` green.

## 5. Verification and docs

- [x] 5.1 Update `package.json` `test:node` and AGENTS.md if new
  test files require it; add `test/plugin-log.test.ts` and
  `test/config-file.test.ts` to the Node list. Verify:
  `node --test` runs all eight files green.
- [x] 5.2 [P] Update docs: `README.md` config table (no hardcoded
  default; resolution chain; config-file section; logging
  section) and the tool-guard and engineer-console sections for
  protected supervisor state (§4.2, §6), `CHANGELOG.md` 2.5.0
  entry, `AGENTS.md` config-resolution bullet,
  `skills/reasoning-auditor/skill.md` model references,
  `src/auditor.ts` JSDoc (FR-059). Verify: no stale
  `google/gemini` references outside history entries.
  Release follow-ups tracked in #30 (docs), #31 (blog), #4
  (tutorial, scope extended), and unbound-force/website#347
  (capability pages).
- [x] 5.3 End-to-end check in a real session: no `[supervisor]`
  lines in the terminal, `opencode-supervisor` entries appear in
  `~/.local/share/opencode/log/opencode.log`, and audit side
  sessions run without `ProviderModelNotFoundError`. Verify:
  observed in a supervised session.
