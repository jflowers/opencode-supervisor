# supervisor-config

## ADDED Requirements

### Requirement: FR-108 a glob file name needs the supervisor directory

In the protected-state check (FR-061), a path whose last segment
holds glob metacharacters MUST match `approvals.json` only when the
segments before it can name the supervisor directory: there are
none, they glob-match a suffix of `opencode/supervisor`, their last
two glob-match `opencode/supervisor`, or one of them is `**`. An
exact `approvals.json` segment MUST still match in any position
(FR-107 unchanged).

#### Scenario: prose glob in a free-text argument

- **WHEN** a non-bash tool argument holds the text
  `no speckit/NNN-* or opsx/* match`
- **THEN** the call is not blocked as touching the approvals file

#### Scenario: glob spellings into the supervisor directory

- **WHEN** a path is `supervisor/*`, `.opencode/su*ervisor/*.json`,
  `**/app*.json`, or a bare `*`
- **THEN** the call is still blocked
