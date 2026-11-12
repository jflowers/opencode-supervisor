/**
 * Per-agent guard overrides and the guard lock (FR-073..FR-075,
 * openspec/changes/agent-guard-overrides): pure validation and
 * resolution. Overrides narrow where a guard applies for one agent's
 * sessions and are honored only from the global config file (design
 * D4); `lockGuards` stops lower-trust tiers from turning guards off
 * (design D5). File I/O, tier bookkeeping, and warning delivery live
 * in index.ts.
 */

/** One agent's override (design D2). Only narrowing keys exist. */
export interface AgentOverride {
  traceCheck?: {
    /** Tool-name globs whose calls skip the file-path trace check (FR-074). */
    exemptTools: string[];
  };
}

/** Validated overrides keyed by exact agent name. */
export type AgentOverrides = Record<string, AgentOverride>;

/**
 * Built-in tools that change workspace files. An exemption matching
 * any of them would disable the trace check where code is written, so
 * such entries are rejected (FR-074, design D3).
 */
export const FILE_MUTATING_BUILTINS: readonly string[] = [
  'bash',
  'edit',
  'write',
  'patch',
  'multiedit',
  'apply_patch',
];

const OVERRIDE_KEYS: readonly string[] = ['traceCheck'];
const TRACE_CHECK_KEYS: readonly string[] = ['exemptTools'];

/**
 * Complexity bounds for one exempt-tool glob, mirroring the trace-check
 * glob compiler (src/tool-guard.ts): a pathological pattern cannot blow
 * the synchronous regex budget.
 */
export const MAX_TOOL_GLOB_LENGTH = 512;
export const MAX_TOOL_GLOB_WILDCARDS = 32;

const countToolGlobWildcards = (glob: string): number => {
  let count = 0;
  for (const ch of glob) {
    if (ch === '*' || ch === '?') count += 1;
  }
  return count;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Compiles a tool-name glob: `*` matches any run of characters, `?`
 * exactly one; everything else is literal. Anchored and
 * case-sensitive (OpenCode tool names are exact keys).
 */
export const compileToolGlob = (glob: string): RegExp => {
  let source = '';
  for (const ch of glob) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
};

/** True when `tool` matches any glob in `globs`. */
export const matchesToolGlob = (tool: string, globs: readonly string[]): boolean =>
  globs.some((glob) => compileToolGlob(glob).test(tool));

/** Validation outcome: accepted overrides plus one warning per dropped entry. */
export interface ParsedAgentOverrides {
  overrides: AgentOverrides;
  warnings: string[];
}

/** Validates one agent's entry; returns the override or the reason it was dropped. */
const validateEntry = (raw: unknown): { override?: AgentOverride; error?: string } => {
  if (!isRecord(raw)) return { error: 'must be an object' };
  const unknown = Object.keys(raw).filter((key) => !OVERRIDE_KEYS.includes(key));
  if (unknown.length > 0) {
    return {
      error: `unknown key(s) ${unknown.map((k) => `"${k}"`).join(', ')}; overrides only narrow guards (allowed: ${OVERRIDE_KEYS.join(', ')})`,
    };
  }
  const override: AgentOverride = {};
  if (raw.traceCheck !== undefined) {
    const traceCheck = raw.traceCheck;
    if (!isRecord(traceCheck)) return { error: '"traceCheck" must be an object' };
    const unknownTrace = Object.keys(traceCheck).filter((key) => !TRACE_CHECK_KEYS.includes(key));
    if (unknownTrace.length > 0) {
      return {
        error: `unknown traceCheck key(s) ${unknownTrace.map((k) => `"${k}"`).join(', ')} (allowed: ${TRACE_CHECK_KEYS.join(', ')})`,
      };
    }
    const tools = traceCheck.exemptTools;
    if (
      !Array.isArray(tools) ||
      tools.some((entry) => typeof entry !== 'string' || entry.trim() === '')
    ) {
      return { error: '"traceCheck.exemptTools" must be an array of non-empty tool-name globs' };
    }
    const globs = tools.map((entry) => (entry as string).trim());
    for (const glob of globs) {
      if (glob.length > MAX_TOOL_GLOB_LENGTH || countToolGlobWildcards(glob) > MAX_TOOL_GLOB_WILDCARDS) {
        return {
          error: `"traceCheck.exemptTools" entry exceeds the compiler's complexity bounds (over ${MAX_TOOL_GLOB_LENGTH} characters or ${MAX_TOOL_GLOB_WILDCARDS} wildcards)`,
        };
      }
      const hit = FILE_MUTATING_BUILTINS.find((builtin) => compileToolGlob(glob).test(builtin));
      if (hit !== undefined) {
        return {
          error: `"traceCheck.exemptTools" entry "${glob}" matches the file-mutating builtin "${hit}"; exemptions may not disable the trace check where code is written`,
        };
      }
    }
    override.traceCheck = { exemptTools: globs };
  }
  return { override };
};

/**
 * Validates an untrusted `agentOverrides` value per entry (design D2):
 * an invalid entry is dropped with a warning naming the agent, and the
 * other entries stay in force. A non-object value drops the whole key
 * with one warning. Never rejects the enclosing file.
 */
export const validateAgentOverrides = (value: unknown): ParsedAgentOverrides => {
  if (!isRecord(value)) {
    return { overrides: {}, warnings: ['"agentOverrides" ignored: must be an object keyed by agent name'] };
  }
  const overrides: AgentOverrides = {};
  const warnings: string[] = [];
  for (const [agent, raw] of Object.entries(value)) {
    if (agent.trim() === '') {
      warnings.push('agentOverrides entry with an empty agent name dropped');
      continue;
    }
    if (agent === '__proto__') {
      warnings.push('agentOverrides entry keyed "__proto__" dropped');
      continue;
    }
    const { override, error } = validateEntry(raw);
    if (error !== undefined || override === undefined) {
      warnings.push(`agentOverrides["${agent}"] dropped: ${error}`);
      continue;
    }
    overrides[agent] = override;
  }
  return { overrides, warnings };
};

/**
 * The exempt reason for a trace-checked call, or null (FR-074). Agent
 * names match exactly; an unknown agent never matches.
 */
export const traceExemptReason = (
  agent: string | undefined,
  tool: string,
  overrides: AgentOverrides | undefined
): string | null => {
  if (agent === undefined || overrides === undefined) return null;
  if (!Object.prototype.hasOwnProperty.call(overrides, agent)) return null;
  const globs = overrides[agent]?.traceCheck?.exemptTools;
  if (globs === undefined || !matchesToolGlob(tool, globs)) return null;
  return `Tool '${tool}' exempt from the file-path trace check for agent '${agent}' by global agentOverrides; reward-hacking and directive checks still applied.`;
};

/** Guard toggles the lock protects (FR-075). */
export const LOCKED_GUARD_KEYS = ['blockRewardHacking', 'requireStepReferenceInTools'] as const;

type GuardToggles = { [K in (typeof LOCKED_GUARD_KEYS)[number]]?: boolean };

/**
 * Removes guard-disabling `false` values from a lower-trust tier when
 * the lock is on (FR-075, design D5). Returns a copy plus one warning
 * per removed key; `true` values and other keys pass through.
 */
export const applyGuardLock = <T extends GuardToggles>(
  tier: T,
  tierName: string,
  locked: boolean
): { config: T; warnings: string[] } => {
  if (!locked) return { config: tier, warnings: [] };
  const config = { ...tier };
  const warnings: string[] = [];
  for (const key of LOCKED_GUARD_KEYS) {
    if (config[key] === false) {
      delete config[key];
      warnings.push(`${tierName} sets ${key}: false; ignored because the global config sets lockGuards: true`);
    }
  }
  return { config, warnings };
};

type NonGlobalTier = GuardToggles & { agentOverrides?: unknown; lockGuards?: unknown; mode?: unknown };

/**
 * Prepares a lower-trust tier (project file or plugin options) for
 * resolution (FR-073, FR-075; design D4/D5): `agentOverrides` and
 * `lockGuards` are honored only from the global file, so both are
 * removed with a warning, and the guard lock then removes
 * guard-disabling `false` values — and a `mode: "repair-only"` that
 * would unregister the guards entirely. Returns a copy; the input is
 * not mutated.
 */
export const sanitizeNonGlobalTier = <T extends NonGlobalTier>(
  tier: T,
  tierName: string,
  locked: boolean
): { config: T; warnings: string[] } => {
  const config = { ...tier };
  const warnings: string[] = [];
  if (config.agentOverrides !== undefined) {
    delete config.agentOverrides;
    warnings.push(`${tierName} sets agentOverrides; ignored — agent overrides are honored only from the global config file`);
  }
  if (config.lockGuards !== undefined) {
    delete config.lockGuards;
    warnings.push(`${tierName} sets lockGuards; ignored — the guard lock is honored only from the global config file`);
  }
  if (locked && config.mode === 'repair-only') {
    delete config.mode;
    warnings.push(`${tierName} sets mode: "repair-only"; ignored because the global config sets lockGuards: true`);
  }
  const lock = applyGuardLock(config, tierName, locked);
  return { config: lock.config, warnings: [...warnings, ...lock.warnings] };
};
