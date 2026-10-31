/**
 * Supervisor config-file parsing (FR-056, FR-057): pure validation
 * for the optional JSON config files that tune the supervisor —
 * project `<dir>/.opencode/supervisor/config.json` and global
 * `${XDG_CONFIG_HOME:-~/.config}/opencode/supervisor/config.json`.
 * A file may set any subset of the hook configuration; unknown keys
 * are ignored; a value of the wrong type, or malformed JSON, rejects
 * the whole file with an error string so the caller can skip the
 * tier and warn once. File I/O lives in index.ts
 * (`readSupervisorConfigFile`), mirroring the approvals reader;
 * parsing and validation are pure here.
 */

import { SUPERVISOR_MODES, type ArgRepairConfig, type SupervisorMode } from './arg-repair.ts';
import type { AuditorVariant } from './auditor.ts';
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
  /** Supervisor mode: 'full' (default) or 'repair-only' (repair only, no other features). */
  mode?: SupervisorMode;
  /** Tool-argument repair overrides; unset keys fall through to the next tier. */
  argRepair?: Partial<ArgRepairConfig>;
}

/** Parse outcome: the accepted subset, or an error when rejected. */
export interface ParsedSupervisorConfig {
  config: SupervisorFileConfig;
  error: string | null;
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

  const numeric: readonly ('maxRegenerations' | 'maxOnDemandAudits' | 'maxTimeoutFailOpens')[] = [
    'maxRegenerations',
    'maxOnDemandAudits',
    'maxTimeoutFailOpens',
  ];
  for (const key of numeric) {
    const parsed = optionalNumber(value, key);
    if (parsed.error !== null) return reject(parsed.error);
    if (parsed.value !== undefined) {
      config[key] = parsed.value;
    }
  }

  const booleanKeys: readonly ('blockRewardHacking' | 'requireStepReferenceInTools')[] = [
    'blockRewardHacking',
    'requireStepReferenceInTools',
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

  return { config, error: null };
};

/**
 * Parses raw config-file text. Malformed JSON rejects with an error
 * string; valid JSON is validated field by field.
 */
export const parseSupervisorConfigFile = (raw: string): ParsedSupervisorConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { config: {}, error: `invalid JSON: ${String(error)}` };
  }
  return validateSupervisorConfig(parsed);
};
