# Spec Delta

## Purpose

Defines where the auditor model comes from: config files, the
resolution chain that orders every source, the fallback derived
from the OpenCode configuration, and the behavior when no model
resolves. Removes the hardcoded model slug that produced
`ProviderModelNotFoundError` on machines without a `google`
provider.

## ADDED Requirements

### Requirement: FR-056 auditor model resolution chain

For each configurable knob (auditor model, auditor variant, strip
mode, regeneration bound, guard toggles, memo limits, on-demand
audit bound), the middleware SHALL resolve the effective value in
this order: session config override, environment variable, project
config file, plugin options, global config file, and finally the
documented default. For the auditor model only, an additional
derived tier SHALL apply after the global config file and before
the default.

#### Scenario: project file overrides global file

- **GIVEN** a global config file setting `auditorModel` and a
  project config file setting a different `auditorModel`
- **WHEN** the effective configuration is resolved
- **THEN** the project file's model wins

#### Scenario: environment overrides project file

- **GIVEN** a project config file setting `auditorModel` and the
  environment variable `OPENCODE_SUPERVISOR_MODEL` set
- **WHEN** the effective configuration is resolved
- **THEN** the environment variable's model wins

### Requirement: FR-057 supervisor config files

The middleware SHALL read optional JSON config files at
`<project>/.opencode/supervisor/config.json` (project) and
`${XDG_CONFIG_HOME:-~/.config}/opencode/supervisor/config.json`
(global). A file MAY set any subset of the hook configuration.
Files larger than the documented size bound SHALL be ignored with
one warning. Malformed or invalid-typed content SHALL be skipped
with one warning; an absent file SHALL resolve as absent. Unknown
keys SHALL be ignored.

#### Scenario: absent file is absent

- **GIVEN** no project config file exists
- **WHEN** configuration is resolved
- **THEN** resolution proceeds without the project tier and
  records no warning

#### Scenario: malformed file is skipped

- **GIVEN** a project config file containing invalid JSON
- **WHEN** configuration is resolved
- **THEN** no value from that file is applied and exactly one
  warning is logged

### Requirement: FR-058 derived fallback model

When no other source sets the auditor model, the middleware SHALL
derive it from the OpenCode configuration via the SDK client,
preferring `small_model` and falling back to `model`. Derivation
SHALL be lazy and memoized on success only, so a failed lookup
during bootstrap is retried on the next resolution. A derived model
SHALL NOT be cached from a failed response. Each attempt SHALL be
time-bounded, and repeated consecutive failures SHALL back off
between attempts, so a hanging or persistently failing endpoint
cannot stall every hook behind the lookup.

#### Scenario: derivation prefers small_model

- **GIVEN** no model set by any other tier and an OpenCode
  configuration with both `model` and `small_model`
- **WHEN** the auditor model is resolved
- **THEN** the `small_model` value is used

#### Scenario: failed derivation retries later

- **GIVEN** a derivation attempt that failed because the server
  listener was not yet up
- **WHEN** the next resolution runs after the listener is up
- **THEN** derivation is attempted again and succeeds

### Requirement: FR-059 no hardcoded auditor model

The middleware SHALL NOT embed a default auditor model slug. The
plugin's built-in defaults SHALL leave the auditor model (and
variant) unset, so a machine whose providers differ from any
baked-in slug still gets a working audit tier through derivation
or configuration.

#### Scenario: fresh install derives a model

- **GIVEN** a machine with no supervisor configuration and an
  OpenCode configuration that sets a model
- **WHEN** the plugin starts and the first audit runs
- **THEN** the auditor model is the derived one and no
  `ProviderModelNotFoundError` originates from the plugin default

### Requirement: FR-060 no-model behavior and optional variant

When no auditor model resolves, the middleware SHALL skip the LLM
audit tier, SHALL still run deterministic invariants, SHALL record
steps that pass invariants as verified, and SHALL log one warning
that the LLM tier is disabled. The auditor variant SHALL be
optional end to end: when unset, the side-session prompt SHALL omit
the variant and the side-session title SHALL degrade to the model
alone.

#### Scenario: invariants still enforce without a model

- **GIVEN** no auditor model resolved anywhere
- **WHEN** a reasoning step violates a deterministic invariant
- **THEN** the step fails audit and the critique is delivered

#### Scenario: unset variant is omitted

- **GIVEN** a resolved auditor model with no variant
- **WHEN** an audit side session is created
- **THEN** the prompt body omits the variant field and the session
  title names the model without a variant suffix

### Requirement: FR-061 protected supervisor state

The tool guard SHALL block agent tool calls whose arguments touch
the supervisor's engineer-authored state beyond the approvals file:
the project and global supervisor config files and the directives
directory. The named files and directories SHALL pair a lexically
normalized path-token match with a raw bash command test, so
traversal spellings and relative directory-change evasion cannot
bypass them. The whole-supervisor-directory backstop applies the
path-token lens only — a raw pairing on the bare word `supervisor`
would false-positive too often — which is the documented residual.
Block reasons SHALL be actionable without revealing the matched
literal.

#### Scenario: agent cannot write the supervisor config file

- **GIVEN** a supervised session with the tool guard active
- **WHEN** a tool call's arguments reference a supervisor config
  file
- **THEN** the call is blocked with a reason that names the
  engineer-authored state and directs the agent to the engineer

#### Scenario: traversal spelling is still blocked

- **GIVEN** a supervised session with the tool guard active
- **WHEN** a tool call's arguments reference the config file
  through `..` segments or a relative directory-change spelling
- **THEN** the call is still blocked
