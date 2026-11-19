# supervisor-config

## ADDED Requirements

### Requirement: FR-107 wildcard directory segments do not match protected files

In the protected-state check (FR-061), when the protected run ends in
a file name (`approvals.json`, `opencode/supervisor/config.json`,
`opencode/supervisor/external-access.json`), a path segment with glob
metacharacters MUST match that file name only when it is the path's
last segment. Exact segment equality MUST still match in any
position, and directory runs MUST keep glob matching in every
position.

#### Scenario: recursive glob in a topic folder

- **WHEN** the agent calls `glob` with pattern `**/*.md` and path
  `topics/wirecheck`
- **THEN** the call is not blocked as touching the approvals file

#### Scenario: glob spelling of the file itself

- **WHEN** a path is `.opencode/su*ervisor/app*vals.json` or
  `**/app*.json`
- **THEN** the call is still blocked
