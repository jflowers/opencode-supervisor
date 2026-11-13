# Spec Delta

## ADDED Requirements

### Requirement: FR-079 Directive paths match real spellings

A `forbidPath` glob (FR-028) and a `when` path glob (FR-029)
SHALL match a path candidate when the glob matches the whole
candidate or any suffix of it that starts after a `/`. Path
candidates for these two rule kinds SHALL be extracted from
top-level string arguments and from string values nested in
array and object arguments, bounded in nesting depth and
count. A glob that starts with `/` SHALL match only whole
candidates.

The loader SHALL read at most `MAX_DIRECTIVE_FILES` (25)
directive files, in name order, and SHALL NOT read or parse
files past the cap; when files are skipped it SHALL emit one
warning naming the count. The identity log line SHALL name each
loaded directive's id and source: `<id>.md` for a file
directive, `options` for a tuple-registered one.

#### Scenario: Dot-relative spelling is forbidden

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a `read` call targets `./secrets/token`
- **THEN** the call is blocked by the directive

#### Scenario: Home and absolute spellings are forbidden

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a bash call runs `cat ~/secrets/token` or
  `cat /home/dev/proj/secrets/token`
- **THEN** the call is blocked by the directive

#### Scenario: Nested argument paths are forbidden

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a tool call carries `secrets/token` only inside an
  array of objects (for example `edits[0].filePath`)
- **THEN** the call is blocked by the directive

#### Scenario: When-path globs trigger on any spelling

- **GIVEN** a directive with `when` path `src/crypto/**`
- **WHEN** an `edit` call targets
  `/home/dev/proj/src/crypto/aes.ts` or `./src/crypto/aes.ts`
- **THEN** the directive is triggered

#### Scenario: Unrelated paths still pass

- **GIVEN** a directive with `forbidPath` `secrets/**`
- **WHEN** a call targets `src/secrets.ts` or `docs/secrets-faq`
- **THEN** the call is not blocked by the directive

#### Scenario: A leading slash anchors at the root

- **GIVEN** a directive with `forbidPath` `/etc/**`
- **WHEN** a call targets `vendor/etc/conf`
- **THEN** the call is not blocked by the directive

#### Scenario: Files past the read cap are not parsed

- **GIVEN** 27 directive files, two of them sorting last and
  malformed
- **WHEN** the plugin loads
- **THEN** no malformed-file warning is emitted for them
- **AND** one warning says 2 directive files were not read

#### Scenario: The identity line names loaded directives

- **GIVEN** a file directive `no-secrets.md` and a tuple
  directive with id `prefer-bun`
- **WHEN** the identity line is logged
- **THEN** it names `no-secrets (no-secrets.md)` and
  `prefer-bun (options)`
