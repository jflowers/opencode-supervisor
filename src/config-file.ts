/**
 * Supervisor config-file parsing (FR-056, FR-057): pure validation
 * for the optional JSON config files that tune the supervisor —
 * project `<dir>/.opencode/supervisor/config.json` and global
 * `${XDG_CONFIG_HOME:-~/.config}/opencode/supervisor/config.json`.
 * A file may set any subset of the hook configuration; unknown keys
 * are ignored; a value of the wrong type, or malformed JSON, rejects
 * the whole file with an error string so the caller can skip the
 * tier and warn once. `profiles` entries are the deliberate
 * exception (FR-073): a bad entry is dropped with a warning carried
 * in `ParsedSupervisorConfig.warnings` so one rogue override cannot
 * reject the rest of the file. File I/O lives in index.ts
 * (`readSupervisorConfigFile`), mirroring the approvals reader;
 * parsing and validation are pure here.
 */

import { validateProfiles, type GuardProfile } from './guard-profiles.ts';
import { SUPERVISOR_MODES, type ArgRepairConfig, type SupervisorMode } from './arg-repair.ts';
import type { AuditorVariant } from './auditor.ts';
import { READ_POLICIES, type ExternalAccessConfig, type ReadPolicy } from './external-access.ts';
import type { MemoLimits } from './memo.ts';
import type { StripMode } from './stripper.ts';

/**
 * Read bound for supervisor config files, mirroring the approvals
 * file bound (design D4): a planted oversized file is skipped with
 * one warning instead of stalling the event loop.
 */
export const MAX_CONFIG_FILE_BYTES = 64 * 1024;

/** The subset of hook configuration a supervisor config file may set. */
export interface SupervisorFileConfig {
  /** Auditor model as a full `<provider>/<model-id>` slug. */
  auditorModel?: string;
  /** Auditor variant from the documented vocabulary. */
  auditorVariant?: AuditorVariant;
  stripMode?: StripMode;
  maxRegenerations?: number;
  blockRewardHacking?: boolean;
  requireStepReferenceInTools?: boolean;
  memoLimits?: Partial<MemoLimits>;
  maxOnDemandAudits?: number;
  /** Per-session cap on trace-check timeout fail-opens (FR-067). */
  maxTimeoutFailOpens?: number;
  /**
   * Per-session cap on covered timeout fail-opens — waits whose
   * blocked token an in-flight audit names (FR-070).
   */
  maxCoveredTimeoutFailOpens?: number;
  /** Supervisor mode: 'full' (default) or 'repair-only' (repair only, no other features). */
  mode?: SupervisorMode;
  /** Tool-argument repair overrides; unset keys fall through to the next tier. */
  argRepair?: Partial<ArgRepairConfig>;
  /**
   * Task-scoped narrowing profiles (FR-073). Parsed from any tier but
   * honored only from the global file — index.ts drops them elsewhere.
   */
  profiles?: GuardProfile[];
  /** Global-file only: lower tiers cannot turn guards off (FR-075). */
  lockGuards?: boolean;
  /** External-access supervision (FR-088); unset keys fall through to the next tier. */
  externalAccess?: Partial<ExternalAccessConfig>;
}

/** Parse outcome: the accepted subset, or an error when rejected. */
export interface ParsedSupervisorConfig {
  config: SupervisorFileConfig;
  error: string | null;
  /**
   * Non-fatal problems (FR-073, design D2): dropped profiles
   * entries. Absent when there are none.
   */
  warnings?: string[];
}

const STRIP_MODES: readonly StripMode[] = ['code_and_math', 'balanced', 'strict'];

const AUDITOR_VARIANTS: readonly AuditorVariant[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'default',
];

const MEMO_LIMIT_KEYS: readonly (keyof MemoLimits)[] = [
  'maxSolvedItems',
  'maxCritiques',
  'maxReminders',
  'maxReports',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (
  owner: Record<string, unknown>,
  key: string
): { value?: string; error: string | null } => {
  const raw = owner[key];
  if (raw === undefined) return { error: null };
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: `"${key}" must be a non-empty string` };
  }
  return { value: raw, error: null };
};

/**
 * Count knobs are whole numbers (review round 5): a fractional or
 * non-finite value rejects the tier instead of rounding silently
 * downstream. `Number.isInteger` folds the finite check in.
 */
const optionalNumber = (
  owner: Record<string, unknown>,
  key: string
): { value?: number; error: string | null } => {
  const raw = owner[key];
  if (raw === undefined) return { error: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return { error: `"${key}" must be a non-negative integer` };
  }
  return { value: raw, error: null };
};

const optionalBoolean = (
  owner: Record<string, unknown>,
  key: string
): { value?: boolean; error: string | null } => {
  const raw = owner[key];
  if (raw === undefined) return { error: null };
  if (typeof raw !== 'boolean') {
    return { error: `"${key}" must be a boolean` };
  }
  return { value: raw, error: null };
};

/**
 * Validates an untrusted config object (file content or plugin tuple
 * options) into a `SupervisorFileConfig`. Unknown keys are ignored;
 * any known key of the wrong type rejects the whole object.
 */
export const validateSupervisorConfig = (value: unknown): ParsedSupervisorConfig => {
  if (!isRecord(value)) {
    return { config: {}, error: 'configuration must be a JSON object' };
  }
  const config: SupervisorFileConfig = {};
  const reject = (error: string): ParsedSupervisorConfig => ({ config: {}, error });

  const model = optionalString(value, 'auditorModel');
  if (model.error !== null) return reject(model.error);
  // Trim before the slug check (review round 5): a whitespace-padded
  // slug passed validation but failed provider resolution later.
  if (model.value !== undefined) config.auditorModel = model.value.trim();
  if (config.auditorModel !== undefined) {
    const slash = config.auditorModel.indexOf('/');
    if (slash <= 0 || slash === config.auditorModel.length - 1) {
      return reject('"auditorModel" must be a provider/model slug (e.g. "provider/model")');
    }
  }

  const variantRaw = value.auditorVariant;
  if (variantRaw !== undefined) {
    if (
      typeof variantRaw !== 'string' ||
      !AUDITOR_VARIANTS.includes(variantRaw as AuditorVariant)
    ) {
      return reject(
        `"auditorVariant" must be one of ${AUDITOR_VARIANTS.join(', ')}`
      );
    }
    config.auditorVariant = variantRaw as AuditorVariant;
  }

  const stripModeRaw = value.stripMode;
  if (stripModeRaw !== undefined) {
    if (
      typeof stripModeRaw !== 'string' ||
      !STRIP_MODES.includes(stripModeRaw as StripMode)
    ) {
      return reject(`"stripMode" must be one of ${STRIP_MODES.join(', ')}`);
    }
    config.stripMode = stripModeRaw as StripMode;
  }

  const modeRaw = value.mode;
  if (modeRaw !== undefined) {
    if (typeof modeRaw !== 'string' || !SUPERVISOR_MODES.includes(modeRaw as SupervisorMode)) {
      return reject(`"mode" must be one of ${SUPERVISOR_MODES.join(', ')}`);
    }
    config.mode = modeRaw as SupervisorMode;
  }

  const numeric: readonly ('maxRegenerations' | 'maxOnDemandAudits' | 'maxTimeoutFailOpens' | 'maxCoveredTimeoutFailOpens')[] = [
    'maxRegenerations',
    'maxOnDemandAudits',
    'maxTimeoutFailOpens',
    'maxCoveredTimeoutFailOpens',
  ];
  for (const key of numeric) {
    const parsed = optionalNumber(value, key);
    if (parsed.error !== null) return reject(parsed.error);
    if (parsed.value !== undefined) {
      config[key] = parsed.value;
    }
  }

  const booleanKeys: readonly ('blockRewardHacking' | 'requireStepReferenceInTools' | 'lockGuards')[] = [
    'blockRewardHacking',
    'requireStepReferenceInTools',
    'lockGuards',
  ];
  for (const key of booleanKeys) {
    const parsed = optionalBoolean(value, key);
    if (parsed.error !== null) return reject(parsed.error);
    if (parsed.value !== undefined) {
      config[key] = parsed.value;
    }
  }

  const memoLimitsRaw = value.memoLimits;
  if (memoLimitsRaw !== undefined) {
    if (!isRecord(memoLimitsRaw)) {
      return reject('"memoLimits" must be an object');
    }
    const limits: Partial<MemoLimits> = {};
    for (const key of MEMO_LIMIT_KEYS) {
      const parsed = optionalNumber(memoLimitsRaw, key);
      if (parsed.error !== null) {
        return reject(`"memoLimits.${key}" must be a non-negative integer`);
      }
      if (parsed.value !== undefined) {
        limits[key] = parsed.value;
      }
    }
    config.memoLimits = limits;
  }

  const argRepairRaw = value.argRepair;
  if (argRepairRaw !== undefined) {
    if (!isRecord(argRepairRaw)) {
      return reject('"argRepair" must be an object');
    }
    const argRepair: Partial<ArgRepairConfig> = {};
    const enabled = optionalBoolean(argRepairRaw, 'enabled');
    if (enabled.error !== null) return reject(enabled.error);
    if (enabled.value !== undefined) argRepair.enabled = enabled.value;
    const repairModel = optionalString(argRepairRaw, 'model');
    if (repairModel.error !== null) return reject(repairModel.error);
    if (repairModel.value !== undefined) {
      const trimmed = repairModel.value.trim();
      const slash = trimmed.indexOf('/');
      if (slash <= 0 || slash === trimmed.length - 1) {
        return reject('"argRepair.model" must be a provider/model slug (e.g. "provider/model")');
      }
      argRepair.model = trimmed;
    }
    const toolsRaw = argRepairRaw.tools;
    if (toolsRaw !== undefined) {
      if (
        !Array.isArray(toolsRaw) ||
        toolsRaw.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
      ) {
        return reject('"argRepair.tools" must be an array of non-empty tool names');
      }
      argRepair.tools = toolsRaw.map((entry) => (entry as string).trim());
    }
    const maxPerSession = optionalNumber(argRepairRaw, 'maxPerSession');
    if (maxPerSession.error !== null) return reject('"argRepair.maxPerSession" must be a non-negative integer');
    if (maxPerSession.value !== undefined) argRepair.maxPerSession = maxPerSession.value;
    const timeoutMs = optionalNumber(argRepairRaw, 'timeoutMs');
    if (timeoutMs.error !== null) return reject('"argRepair.timeoutMs" must be a non-negative integer');
    if (timeoutMs.value !== undefined) argRepair.timeoutMs = timeoutMs.value;
    config.argRepair = argRepair;
  }

  // FR-088: external-access supervision. Unknown sub-keys are
  // ignored like argRepair's; a wrong-typed value rejects the tier.
  const externalAccessRaw = value.externalAccess;
  if (externalAccessRaw !== undefined) {
    if (!isRecord(externalAccessRaw)) {
      return reject('"externalAccess" must be an object');
    }
    const externalAccess: Partial<ExternalAccessConfig> = {};
    const enabled = optionalBoolean(externalAccessRaw, 'enabled');
    if (enabled.error !== null) return reject('"externalAccess.enabled" must be a boolean');
    if (enabled.value !== undefined) externalAccess.enabled = enabled.value;
    const readPolicy = externalAccessRaw.readPolicy;
    if (readPolicy !== undefined) {
      if (typeof readPolicy !== 'string' || !READ_POLICIES.includes(readPolicy as ReadPolicy)) {
        return reject(`"externalAccess.readPolicy" must be one of ${READ_POLICIES.join(', ')}`);
      }
      externalAccess.readPolicy = readPolicy as ReadPolicy;
    }
    config.externalAccess = externalAccess;
  }

  // FR-073 (design D2): profiles validate one by one — a bad
  // profile is dropped with a warning instead of rejecting the file,
  // so a typo in one profile cannot also drop lockGuards.
  if (value.profiles !== undefined) {
    const parsed = validateProfiles(value.profiles);
    config.profiles = parsed.profiles;
    if (parsed.warnings.length > 0) {
      return { config, error: null, warnings: parsed.warnings };
    }
  }

  return { config, error: null };
};

/**
 * Parses raw config-file text. Malformed JSON rejects with an error
 * string; valid JSON is validated field by field.
 */
export const parseSupervisorConfigFile = (raw: string): ParsedSupervisorConfig => {
  let parsed: unknown;
  let result: ParsedSupervisorConfig;
  try {
    parsed = JSON.parse(raw);
    result = validateSupervisorConfig(parsed);
  } catch (error) {
    result = { config: {}, error: `invalid JSON: ${String(error)}` };
  }
  // FR-075 (design D6): the guard lock fails closed. A file rejected
  // for any other reason (a wrong-typed key, malformed JSON) still
  // keeps `lockGuards: true` when it asks for it, so one typo cannot
  // silently unlock the guards for every lower tier.
  if (result.error !== null && lockRequested(parsed, raw)) {
    return { config: { lockGuards: true }, error: result.error };
  }
  return result;
};

/**
 * True when a config file asks for the guard lock: parsed JSON with
 * `lockGuards: true`, or — when the JSON does not parse — the literal
 * text `"lockGuards": true`. Used only on rejected files.
 */
export const lockRequested = (parsed: unknown, raw: string): boolean => {
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return (parsed as Record<string, unknown>).lockGuards === true;
  }
  return /"lockGuards"\s*:\s*true\b/.test(raw);
};

/** The 1.x environment-variable prefix (renamed in 2.0.0, FR-019). */
export const LEGACY_ENV_PREFIX = 'OPENCODE_AUDITOR_';

/** The 2.x environment-variable prefix that replaced it. */
export const SUPERVISOR_ENV_PREFIX = 'OPENCODE_SUPERVISOR_';

/** Most legacy names one warning lists before counting the rest (FR-076, design D3). */
export const MAX_LEGACY_ENV_NAMES = 10;

/**
 * Names of set legacy 1.x variables (FR-076, design D1): sorted names
 * with the `OPENCODE_AUDITOR_` prefix and a non-empty value. Only
 * presence is tested — values are never returned, so they can never
 * be logged or applied (FR-019 stays a clean break).
 */
export const detectLegacyEnvNames = (env: Record<string, string | undefined>): string[] =>
  Object.keys(env)
    .filter((name) => name.startsWith(LEGACY_ENV_PREFIX) && typeof env[name] === 'string' && env[name] !== '')
    .sort();

/**
 * One bounded migration warning for the detected legacy names
 * (FR-076, design D2/D3), or null when there are none. Each name is
 * paired with its `OPENCODE_SUPERVISOR_` replacement; the endpoint
 * variable, removed in 1.0, is named as removed.
 */
export const legacyEnvWarning = (names: readonly string[]): string | null => {
  if (names.length === 0) {
    return null;
  }
  const listed = names.slice(0, MAX_LEGACY_ENV_NAMES).map((name) =>
    name === `${LEGACY_ENV_PREFIX}ENDPOINT`
      ? `${name} (removed in 1.0, no replacement)`
      : `${name} → ${SUPERVISOR_ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`
  );
  const remainder = names.length - listed.length;
  const more = remainder > 0 ? `, and ${remainder} more` : '';
  return (
    `legacy 1.x environment variables are set and ignored: ${listed.join(', ')}${more}. ` +
    'Rename them (values are not read); see README "Migrating from 1.x".'
  );
};
