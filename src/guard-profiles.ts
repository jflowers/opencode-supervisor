/**
 * Task-scoped guard profiles and the guard lock (FR-072..FR-075,
 * openspec/changes/agent-guard-overrides): pure validation, matching,
 * and resolution. A profile narrows where a guard applies for the
 * sessions running one task — a slash command, an agent, or both —
 * and for their descendant sessions (design D4). Profiles are honored
 * only from the global config file (design D5); `lockGuards` stops
 * lower-trust tiers from turning guards off (design D6). Session
 * context capture, tier bookkeeping, and warning delivery live in
 * index.ts.
 */

/** What a profile matches on: every key present must equal the session's value. */
export interface ProfileMatch {
  agent?: string;
  /** Slash command name without a leading `/`. */
  command?: string;
}

/** One validated profile (design D2). Only narrowing grants exist. */
export interface GuardProfile {
  /** Label for reasons and logs; defaults to `profiles[<index>]`. */
  name: string;
  match: ProfileMatch;
  traceCheck: {
    /** Tool-name globs whose calls skip the file-path trace check (FR-074). */
    exemptTools: string[];
  };
}

/** A session's recorded task context (FR-072). */
export interface SessionContext {
  agent?: string;
  command?: string;
}

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

/**
 * Complexity bounds for one exempt-tool glob, mirroring the trace-check
 * glob compiler (src/tool-guard.ts): a pathological pattern cannot blow
 * the synchronous regex budget.
 */
export const MAX_TOOL_GLOB_LENGTH = 512;
export const MAX_TOOL_GLOB_WILDCARDS = 32;

/** Profiles kept from the global file; extras are dropped with a warning. */
export const MAX_PROFILES = 64;

/** Ancestor levels walked when matching (design D4). */
export const MAX_PROFILE_ANCESTRY = 8;

const PROFILE_KEYS: readonly string[] = ['name', 'match', 'traceCheck'];
const MATCH_KEYS: readonly string[] = ['agent', 'command'];
const TRACE_CHECK_KEYS: readonly string[] = ['exemptTools'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const quoteKeys = (keys: string[]): string => keys.map((k) => `"${k}"`).join(', ');

const countToolGlobWildcards = (glob: string): number => {
  let count = 0;
  for (const ch of glob) {
    if (ch === '*' || ch === '?') count += 1;
  }
  return count;
};

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

/** Normalizes a slash command name: trimmed, without a leading `/`. */
export const normalizeCommand = (command: string): string => command.trim().replace(/^\/+/, '');

/** Validates a `match` object; returns it normalized, or the reason it is invalid. */
const validateMatch = (raw: unknown): { match?: ProfileMatch; error?: string } => {
  if (!isRecord(raw)) return { error: '"match" must be an object with "agent" and/or "command"' };
  const unknown = Object.keys(raw).filter((key) => !MATCH_KEYS.includes(key));
  if (unknown.length > 0) {
    return { error: `unknown match key(s) ${quoteKeys(unknown)} (allowed: ${MATCH_KEYS.join(', ')})` };
  }
  const match: ProfileMatch = {};
  if (raw.agent !== undefined) {
    if (typeof raw.agent !== 'string' || raw.agent.trim() === '') return { error: '"match.agent" must be a non-empty string' };
    match.agent = raw.agent.trim();
  }
  if (raw.command !== undefined) {
    const command = typeof raw.command === 'string' ? normalizeCommand(raw.command) : '';
    if (command === '') return { error: '"match.command" must be a non-empty slash command name' };
    match.command = command;
  }
  if (match.agent === undefined && match.command === undefined) {
    return { error: '"match" must set "agent" and/or "command"' };
  }
  return { match };
};

/** Validates a `traceCheck` grant; returns its globs, or the reason it is invalid. */
const validateTraceCheck = (raw: unknown): { exemptTools?: string[]; error?: string } => {
  if (raw === undefined) return { error: '"traceCheck" is required: a profile must grant something' };
  if (!isRecord(raw)) return { error: '"traceCheck" must be an object' };
  const unknown = Object.keys(raw).filter((key) => !TRACE_CHECK_KEYS.includes(key));
  if (unknown.length > 0) {
    return { error: `unknown traceCheck key(s) ${quoteKeys(unknown)} (allowed: ${TRACE_CHECK_KEYS.join(', ')})` };
  }
  const tools = raw.exemptTools;
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    return { error: '"traceCheck.exemptTools" must be a non-empty array of non-empty tool-name globs' };
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
  return { exemptTools: globs };
};

/** Validates one profile; returns it or the reason it was dropped. */
const validateProfile = (raw: unknown, index: number): { profile?: GuardProfile; label: string; error?: string } => {
  let label = `profiles[${index}]`;
  if (!isRecord(raw)) return { label, error: 'must be an object' };
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.trim() === '') return { label, error: '"name" must be a non-empty string' };
    label = raw.name.trim();
  }
  const unknown = Object.keys(raw).filter((key) => !PROFILE_KEYS.includes(key));
  if (unknown.length > 0) {
    return {
      label,
      error: `unknown key(s) ${quoteKeys(unknown)}; profiles only narrow guards (allowed: ${PROFILE_KEYS.join(', ')})`,
    };
  }
  const match = validateMatch(raw.match);
  if (match.error !== undefined || match.match === undefined) return { label, error: match.error };
  const trace = validateTraceCheck(raw.traceCheck);
  if (trace.error !== undefined || trace.exemptTools === undefined) return { label, error: trace.error };
  return { label, profile: { name: label, match: match.match, traceCheck: { exemptTools: trace.exemptTools } } };
};

/** Validation outcome: accepted profiles plus one warning per dropped profile. */
export interface ParsedProfiles {
  profiles: GuardProfile[];
  warnings: string[];
}

/**
 * Validates an untrusted `profiles` value per profile (design D2): an
 * invalid profile is dropped with a warning naming it, and the others
 * stay in force. A non-array value drops the whole key with one
 * warning; profiles beyond MAX_PROFILES are dropped with one warning.
 * Never rejects the enclosing file.
 */
export const validateProfiles = (value: unknown): ParsedProfiles => {
  if (!Array.isArray(value)) {
    return { profiles: [], warnings: ['"profiles" ignored: must be an array of profile objects'] };
  }
  const profiles: GuardProfile[] = [];
  const warnings: string[] = [];
  value.slice(0, MAX_PROFILES).forEach((raw, index) => {
    const { profile, label, error } = validateProfile(raw, index);
    if (profile === undefined) {
      warnings.push(`profile "${label}" dropped: ${error}`);
      return;
    }
    profiles.push(profile);
  });
  if (value.length > MAX_PROFILES) {
    warnings.push(`${value.length - MAX_PROFILES} profile(s) beyond the cap of ${MAX_PROFILES} dropped`);
  }
  return { profiles, warnings };
};

/** True when every key of `match` equals the context's value. */
export const profileMatchesContext = (match: ProfileMatch, context: SessionContext): boolean =>
  (match.agent === undefined || match.agent === context.agent) &&
  (match.command === undefined || match.command === context.command);

/**
 * The profiles that apply to a session (FR-074, design D4): those
 * matching the session's own context or an ancestor's. `lineage` is
 * the session's context first, then its parent's, and so on; only the
 * first MAX_PROFILE_ANCESTRY + 1 entries are consulted.
 */
export const applicableProfiles = (
  lineage: readonly SessionContext[],
  profiles: readonly GuardProfile[] | undefined
): GuardProfile[] => {
  if (profiles === undefined || profiles.length === 0) return [];
  const chain = lineage.slice(0, MAX_PROFILE_ANCESTRY + 1);
  return profiles.filter((profile) => chain.some((context) => profileMatchesContext(profile.match, context)));
};

/**
 * The applied profile and reason for a trace-checked call, or null
 * (FR-074). The first applicable profile whose globs match the tool
 * names the exemption; grants are a union, so order only picks the
 * label.
 */
export const traceExemption = (
  lineage: readonly SessionContext[],
  tool: string,
  profiles: readonly GuardProfile[] | undefined
): { profile: string; reason: string } | null => {
  const hit = applicableProfiles(lineage, profiles).find((profile) => matchesToolGlob(tool, profile.traceCheck.exemptTools));
  if (hit === undefined) return null;
  return {
    profile: hit.name,
    reason: `Tool '${tool}' exempt from the file-path trace check by global profile '${hit.name}'; reward-hacking, directive, and protected-state checks still applied.`,
  };
};

/** Guard toggles the lock protects (FR-075). */
export const LOCKED_GUARD_KEYS = ['blockRewardHacking', 'requireStepReferenceInTools'] as const;

type GuardToggles = { [K in (typeof LOCKED_GUARD_KEYS)[number]]?: boolean };

/**
 * Removes guard-disabling `false` values from a lower-trust tier when
 * the lock is on (FR-075, design D6). Returns a copy plus one warning
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

type NonGlobalTier = GuardToggles & { profiles?: unknown; lockGuards?: unknown; mode?: unknown };

/**
 * Prepares a lower-trust tier (project file or plugin options) for
 * resolution (FR-073, FR-075; design D5/D6): `profiles` and
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
  if (config.profiles !== undefined) {
    delete config.profiles;
    warnings.push(`${tierName} sets profiles; ignored — guard profiles are honored only from the global config file`);
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
