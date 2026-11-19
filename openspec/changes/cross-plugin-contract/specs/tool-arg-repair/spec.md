# tool-arg-repair

## ADDED Requirements

### Requirement: FR-104 repair keeps keys it did not change

When tool-arg repair applies repaired arguments, every emitted
top-level key that the schema validation did not flag MUST keep its
emitted value, unless the repair moved that value to another key or
keeping it would make the repaired arguments fail validation. Keys
the validation flagged MAY be changed or removed by the repair.

#### Scenario: another plugin added keys first

- **GIVEN** a `tool.execute.before` hook of another plugin added
  `source_id`, `tags`, and `tag` to the arguments
- **AND** the arguments are malformed in another key
- **WHEN** the supervisor repairs them, deterministically or with the
  repair model
- **THEN** the repaired arguments still carry `source_id`, `tags`,
  and `tag` with their original values

#### Scenario: repair model rewrites an unflagged key

- **GIVEN** an emitted key that passed validation
- **WHEN** the repair model returns a different value for it
- **THEN** the emitted value is applied

#### Scenario: renamed key

- **GIVEN** an emitted `contents` key and a schema requiring `content`
- **WHEN** the repair moves the value to `content`
- **THEN** `contents` is not restored

#### Scenario: keeping a key would break validity

- **GIVEN** a root-level validation failure that flags no key
- **WHEN** restoring an emitted key makes the result invalid
- **THEN** that key is not restored and the result validates
