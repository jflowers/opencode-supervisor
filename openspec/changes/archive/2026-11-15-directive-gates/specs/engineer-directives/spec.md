# Spec Delta

## ADDED Requirements

### Requirement: Approve and review rule kinds in the fence

The supervisor fence SHALL accept two additional rule kinds
alongside `enforce` and `when`: `approve` (array of approval
gate rules) and `review` (array of review gate rules).
Loading, validation, warnings, and bounds for these kinds
SHALL follow the same fail-open pipeline as the existing
kinds. Directive options registered via `options.directives`
SHALL accept the same rule kinds. Rendering of the advisory
text SHALL NOT include gate rule internals.

#### Scenario: fence with approve rules loads
- **WHEN** a directive file's supervisor fence contains an
      `approve` array
- **THEN** the directive loads with those rules attached
      and the advisory text rides the memo as before

#### Scenario: options-registered directive carries gates
- **WHEN** a directive is registered via `options.directives`
      with `approve` rules
- **THEN** its gates are compiled and enforced identically
      to file-loaded directives

#### Scenario: advisory render unchanged by gate rules
- **WHEN** a directive carries approve and review rules
- **THEN** the rendered advisory shows the directive id and
      text without gate rule internals
