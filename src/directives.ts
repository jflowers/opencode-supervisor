/**
 * Engineer-directive parsing, compilation, matching, and rendering
 * for the engineer console (FR-026 .. FR-032), including the
 * approve-gate and review-gate rule kinds (FR-043 .. FR-048).
 *
 * Directives are engineer-authored policy riding the same
 * session-state layer as the audit loop and the agent console:
 * advisory text is re-injected through the supervisor memo and the
 * peer-audit prompt, while `enforce` rules are compiled into the
 * tool guard. This module is fully pure — filesystem loading lives
 * in index.ts (design D3) — and every parse or compile failure is
 * fail-open: malformed input is skipped with a warning instead of
 * throwing (FR-032). An empty directive set never blocks anything
 * and reproduces 2.1.0 behavior (FR-026).
 */

export interface EnforcementRule {
  forbidPath?: string;
  forbidPattern?: string;
}

export interface TriggerRule {
  tool?: string;
  path?: string;
}

/**
 * An approval-gate rule (FR-043): matching tool calls are held
 * until the engineer records the gate key in the approvals file.
 * At least one of tool/path/pattern is required (an empty rule
 * would match every call); `id` overrides the derived gate key.
 */
export interface ApproveRule {
  id?: string;
  tool?: string;
  path?: string;
  pattern?: string;
}

/**
 * A review-gate rule (FR-047): matching tool calls are held
 * until the verified trace references the touched path.
 */
export interface ReviewRule {
  path: string;
}

/**
 * A repair-scope rule: `tool` is a tool name or glob; matching tools join
 * the tool-argument repair scope on top of the `argRepair.tools` config
 * list (covers MCP and plugin tools that are not builtin).
 */
export interface RepairRule {
  tool: string;
}

export interface Directive {
  id: string;
  text: string;
  enforce?: EnforcementRule[];
  when?: TriggerRule[];
  approve?: ApproveRule[];
  review?: ReviewRule[];
  repair?: RepairRule[];
}

/** Minimal render shape consumed by the memo and audit prompt. */
export interface DirectiveText {
  id: string;
  text: string;
}

export interface CompiledForbidPath {
  regex: RegExp;
  glob: string;
  directiveId: string;
  text: string;
}

export interface CompiledForbidPattern {
  regex: RegExp;
  source: string;
  directiveId: string;
  text: string;
}

export interface CompiledEnforcement {
  forbidPaths: CompiledForbidPath[];
  forbidPatterns: CompiledForbidPattern[];
}

/** Fixed bounds — non-configurable by design (D8, FR-032). */
export const MAX_DIRECTIVES = 20;
export const MAX_DIRECTIVE_TEXT = 1000;
export const MAX_RULES_PER_DIRECTIVE = 10;
export const MAX_DIRECTIVES_RENDER_BUDGET = 4000;
/**
 * Read-time cap on directive files (FR-079): the loader reads at most
 * this many `.md` files in name order and never parses the rest. Set
 * above MAX_DIRECTIVES so a few malformed files cannot starve the set.
 */
export const MAX_DIRECTIVE_FILES = 25;

const FENCE_PATTERN = /```supervisor\r?\n([\s\S]*?)```/;

export interface DirectiveFile {
  name: string;
  content: string;
}

export interface ParseDirectivesResult {
  directives: Directive[];
  warnings: string[];
}

interface RawRules {
  enforce?: unknown;
  when?: unknown;
  approve?: unknown;
  review?: unknown;
  repair?: unknown;
}

/** Normalized rules of one kind plus the count of entries dropped. */
interface NormalizedRules<T> {
  rules: T[];
  dropped: number;
}

/** A trimmed non-empty string field of a raw rule record, or undefined. */
const trimmedField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

/**
 * Generic rule-list normalizer (FR-032, design D8 of the
 * advisory-sweep change): absent input is no rules; a non-array
 * counts as one dropped entry; at most MAX_RULES_PER_DIRECTIVE
 * entries are considered and the overflow counts as dropped; a
 * non-object entry, or one `toRule` rejects with null, is dropped.
 * Each rule kind supplies only its per-entry mapping.
 *
 * @param raw The raw rule list from a fence or options entry.
 * @param toRule Maps one raw record to a rule, or null to drop it.
 * @returns The kept rules and the dropped count.
 */
const normalizeRules = <T>(
  raw: unknown,
  toRule: (record: Record<string, unknown>) => T | null
): NormalizedRules<T> => {
  if (raw === undefined || raw === null) return { rules: [], dropped: 0 };
  if (!Array.isArray(raw)) return { rules: [], dropped: 1 };
  const rules: T[] = [];
  let dropped = 0;
  for (const entry of raw.slice(0, MAX_RULES_PER_DIRECTIVE)) {
    const rule = typeof entry === 'object' && entry !== null ? toRule(entry as Record<string, unknown>) : null;
    if (rule === null) {
      dropped += 1;
    } else {
      rules.push(rule);
    }
  }
  if (raw.length > MAX_RULES_PER_DIRECTIVE) {
    dropped += raw.length - MAX_RULES_PER_DIRECTIVE;
  }
  return { rules, dropped };
};

/** `enforce` entries need a forbidPath or a forbidPattern (FR-028). */
const toEnforcementRule = (record: Record<string, unknown>): EnforcementRule | null => {
  const forbidPath = trimmedField(record, 'forbidPath');
  const forbidPattern = trimmedField(record, 'forbidPattern');
  if (forbidPath === undefined && forbidPattern === undefined) return null;
  return {
    ...(forbidPath !== undefined ? { forbidPath } : {}),
    ...(forbidPattern !== undefined ? { forbidPattern } : {}),
  };
};

/** `when` entries need a tool or a path (FR-029). */
const toTriggerRule = (record: Record<string, unknown>): TriggerRule | null => {
  const tool = trimmedField(record, 'tool');
  const path = trimmedField(record, 'path');
  if (tool === undefined && path === undefined) return null;
  return { ...(tool !== undefined ? { tool } : {}), ...(path !== undefined ? { path } : {}) };
};

/**
 * `approve` entries (FR-043, design D7): a rule needs at least one
 * of tool/path/pattern — an empty rule would match every call.
 */
const toApproveRule = (record: Record<string, unknown>): ApproveRule | null => {
  const id = trimmedField(record, 'id');
  const tool = trimmedField(record, 'tool');
  const path = trimmedField(record, 'path');
  const pattern = trimmedField(record, 'pattern');
  if (tool === undefined && path === undefined && pattern === undefined) return null;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(tool !== undefined ? { tool } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
  };
};

/** `review` entries (FR-047, design D7) are a path glob and nothing else. */
const toReviewRule = (record: Record<string, unknown>): ReviewRule | null => {
  const path = trimmedField(record, 'path');
  return path === undefined ? null : { path };
};

/** `repair` entries are a tool name or glob and nothing else. */
const toRepairRule = (record: Record<string, unknown>): RepairRule | null => {
  const tool = trimmedField(record, 'tool');
  return tool === undefined ? null : { tool };
};

/**
 * Shared build step for file and options directives (design D8):
 * truncates the advisory text with a warning, normalizes the five
 * rule kinds, records one warning per kind that dropped entries,
 * and returns null for a directive with neither text nor rules —
 * the caller emits its own source-specific skip warning.
 *
 * @param id The directive id.
 * @param rawText The trimmed advisory text, before truncation.
 * @param rawRules The raw rule lists keyed by kind.
 * @param warnings The warning list to append to.
 * @returns The directive, or null when it carries nothing.
 */
const buildDirective = (
  id: string,
  rawText: string,
  rawRules: RawRules,
  warnings: string[]
): Directive | null => {
  if (rawText.length > MAX_DIRECTIVE_TEXT) {
    warnings.push(
      `directive '${id}' advisory text truncated from ${rawText.length} to ${MAX_DIRECTIVE_TEXT} characters`
    );
  }
  const text = rawText.slice(0, MAX_DIRECTIVE_TEXT);
  const kinds = {
    enforce: normalizeRules(rawRules.enforce, toEnforcementRule),
    when: normalizeRules(rawRules.when, toTriggerRule),
    approve: normalizeRules(rawRules.approve, toApproveRule),
    review: normalizeRules(rawRules.review, toReviewRule),
    repair: normalizeRules(rawRules.repair, toRepairRule),
  };
  for (const [kind, normalized] of Object.entries(kinds)) {
    if (normalized.dropped > 0) {
      warnings.push(
        `directive '${id}': ${normalized.dropped} ${kind} rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
  }
  const { enforce, when, approve, review, repair } = kinds;
  if (
    !text &&
    enforce.rules.length === 0 &&
    when.rules.length === 0 &&
    approve.rules.length === 0 &&
    review.rules.length === 0 &&
    repair.rules.length === 0
  ) {
    return null;
  }
  return {
    id,
    text,
    ...(enforce.rules.length > 0 ? { enforce: enforce.rules } : {}),
    ...(when.rules.length > 0 ? { when: when.rules } : {}),
    ...(approve.rules.length > 0 ? { approve: approve.rules } : {}),
    ...(review.rules.length > 0 ? { review: review.rules } : {}),
    ...(repair.rules.length > 0 ? { repair: repair.rules } : {}),
  };
};

/**
 * Parse directive files (FR-026, FR-027). Each file's markdown body
 * is the advisory text; the first ```supervisor-fenced block holds a
 * JSON rules object. The file id is the filename without `.md`.
 * Malformed files are skipped with a warning (fail-open).
 *
 * @param files The directive files read by the loader.
 * @returns The parsed directives and the load warnings.
 */
export const parseDirectives = (files: DirectiveFile[]): ParseDirectivesResult => {
  const directives: Directive[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const id = file.name.replace(/\.md$/, '');
    let text = file.content;
    let rawRules: RawRules = {};
    const fence = file.content.match(FENCE_PATTERN);
    if (fence) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fence[1]);
      } catch {
        warnings.push(
          `directive file '${file.name}' has a malformed supervisor rules block; file skipped`
        );
        continue;
      }
      // JSON.parse accepts `null`, arrays, and scalars — only an
      // object can carry rules (review round 1: a `null` fence threw
      // out of server() and broke plugin load, violating FR-032).
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        warnings.push(
          `directive file '${file.name}' supervisor rules block is not a JSON object; file skipped`
        );
        continue;
      }
      rawRules = parsed as RawRules;
      text = file.content.replace(FENCE_PATTERN, '');
    }
    const directive = buildDirective(id, text.trim(), rawRules, warnings);
    if (directive === null) {
      warnings.push(
        `directive file '${file.name}' has neither advisory text nor rules; file skipped`
      );
      continue;
    }
    directives.push(directive);
  }
  return { directives, warnings };
};

/**
 * Parse the `options.directives` array from tuple plugin
 * registration (FR-026). Same validation as files; entries without
 * an id get `d<index>`.
 *
 * @param raw The `options.directives` value.
 * @returns The parsed directives and the load warnings.
 */
export const parseOptionsDirectives = (raw: unknown): ParseDirectivesResult => {
  if (raw === undefined || raw === null) {
    return { directives: [], warnings: [] };
  }
  if (!Array.isArray(raw)) {
    return { directives: [], warnings: ['options.directives is not an array; ignored'] };
  }
  const directives: Directive[] = [];
  const warnings: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`options.directives[${index}] is not an object; skipped`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = trimmedField(record, 'id') ?? `d${index + 1}`;
    const rawText = typeof record.text === 'string' ? record.text.trim() : '';
    const directive = buildDirective(id, rawText, record as RawRules, warnings);
    if (directive === null) {
      warnings.push(`options.directives[${index}] ('${id}') has neither text nor rules; skipped`);
      return;
    }
    directives.push(directive);
  });
  return { directives, warnings };
};

/**
 * Renders the loaded directives with their sources for the identity
 * log line (FR-079): `<id> (<id>.md)` for a file directive — the
 * loader reads only `.md` files and the id is the name without the
 * extension — and `<id> (options)` for a tuple-registered one.
 *
 * @param loaded The directives in effect, after the count cap.
 * @param fromFiles The directives parsed from files (identity compared).
 * @returns The comma-separated provenance list, or '' when none loaded.
 */
export const describeDirectiveSources = (loaded: Directive[], fromFiles: Directive[]): string =>
  loaded
    .map((directive) => `${directive.id} (${fromFiles.includes(directive) ? `${directive.id}.md` : 'options'})`)
    .join(', ');

/**
 * Compile a glob to an anchored RegExp (design D4): a `**` segment
 * (optionally slash-terminated) matches zero or more path segments,
 * a bare `**` matches anything including slashes, and `*` and `?`
 * stay within one segment. Everything else is literal. A double-star
 * segment followed by a slash is
 * translated to segment-anchored chunks (a non-slash run followed by
 * a slash, repeated) so repeated
 * glob segments stay near-linear on long non-matching paths (review
 * round 1: dot-star chunks backtracked combinatorially on the guard
 * hot path). Matching is case-insensitive, matching the guard's
 * trace-check convention — path case is not a reliable policy signal
 * on macOS or Windows filesystems. Never throws.
 */
export const globToRegExp = (glob: string): RegExp => {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:[^/]*/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.\+^${}()|\[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'i');
};

/**
 * Path-candidate pattern for directive matching (FR-028, FR-029):
 * slash-containing path tokens (optionally absolute) plus bare
 * dotfile names. Deliberately broader than the trace check's
 * source-extension extractor — a forbidPath glob must see `.env`,
 * `secrets/credentials.pem`, and extensionless paths the extension
 * allowlist would miss (review round 1). Glob metacharacters
 * (`*?[]`) are class members so bash glob spellings extract whole —
 * fragmenting at the metacharacter had let
 * `.opencode/su*ervisor/app*vals.json` slip past the
 * protected-state guard (review round 5). Over-extraction is safe:
 * candidates only matter when a directive glob still has to match.
 */
const POLICY_PATH_PATTERN =
  /\/?[A-Za-z0-9_.\-~@*?\[\]]+\/[A-Za-z0-9_.\-~@/*?\[\]]*|\.[A-Za-z0-9][A-Za-z0-9_.\-*?\[\]]*/g;

/**
 * Extracts policy-relevant path candidates from tool arguments
 * (FR-028, FR-029): top-level string values scanned for path-like
 * tokens. Feeds enforcement matching and trigger recording; the
 * trace check keeps its own source-extension extractor (FR-010).
 */
export function extractPolicyPaths(args: Record<string, unknown> | undefined): string[] {
  return Object.values(args || {})
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.match(POLICY_PATH_PATTERN) || []);
}

/** Nesting depth below the top-level arguments that directive matching reads (FR-079). */
export const MAX_NESTED_ARG_DEPTH = 4;

/** Cap on string values collected from one call's arguments for directive matching (FR-079). */
export const MAX_NESTED_ARG_STRINGS = 256;

/**
 * Extracts directive path candidates from tool arguments (FR-079):
 * the `extractPolicyPaths` pattern applied to every string value
 * reachable through arrays and plain objects — so `edits[0].filePath`
 * is seen — bounded at MAX_NESTED_ARG_DEPTH levels below the top and
 * MAX_NESTED_ARG_STRINGS values. Feeds `forbidPath` enforcement and
 * `when` triggers only; the protected-state lens and the FR-071 scan
 * keep the top-level `extractPolicyPaths`.
 *
 * @param args The tool-call arguments.
 * @returns The path candidates, in argument order.
 */
export function extractDirectivePaths(args: Record<string, unknown> | undefined): string[] {
  const strings: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (strings.length >= MAX_NESTED_ARG_STRINGS) return;
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if (depth > MAX_NESTED_ARG_DEPTH || typeof value !== 'object' || value === null) return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child, depth + 1);
    }
  };
  visit(args ?? {}, 0);
  return strings.flatMap((value) => value.match(POLICY_PATH_PATTERN) || []);
}

/**
 * Matches a compiled directive glob against path candidates (FR-079):
 * a candidate matches when the glob matches the whole candidate or
 * any suffix starting after a `/` — so `./secrets/token`,
 * `~/secrets/token`, and `/abs/proj/secrets/token` all match
 * `secrets/**`, and the basename (the shortest suffix) keeps
 * `.env*` matching anywhere. Suffixes never start with `/`, so a
 * glob written with a leading `/` matches whole candidates only.
 *
 * @param regex A glob compiled by `globToRegExp`.
 * @param paths The path candidates of one tool call.
 * @returns The first matching candidate, or undefined.
 */
export const matchesPaths = (regex: RegExp, paths: string[]): string | undefined =>
  paths.find((candidate) => {
    if (regex.test(candidate)) return true;
    for (let slash = candidate.indexOf('/'); slash !== -1; slash = candidate.indexOf('/', slash + 1)) {
      const suffix = candidate.slice(slash + 1);
      if (suffix !== '' && regex.test(suffix)) return true;
    }
    return false;
  });

/**
 * Compile enforcement rules for the tool guard (FR-028). Invalid
 * forbid-pattern regexes are skipped with a warning (fail-open,
 * FR-032); glob compilation cannot throw.
 */
export const compileEnforcement = (
  directives: Directive[]
): { enforcement: CompiledEnforcement; warnings: string[] } => {
  const forbidPaths: CompiledForbidPath[] = [];
  const forbidPatterns: CompiledForbidPattern[] = [];
  const warnings: string[] = [];
  for (const directive of directives) {
    for (const rule of directive.enforce ?? []) {
      if (rule.forbidPath !== undefined) {
        forbidPaths.push({
          regex: globToRegExp(rule.forbidPath),
          glob: rule.forbidPath,
          directiveId: directive.id,
          text: directive.text,
        });
      }
      if (rule.forbidPattern !== undefined) {
        try {
          forbidPatterns.push({
            regex: new RegExp(rule.forbidPattern, 'i'),
            source: rule.forbidPattern,
            directiveId: directive.id,
            text: directive.text,
          });
        } catch {
          warnings.push(
            `directive '${directive.id}' forbidPattern '${rule.forbidPattern}' is not a valid regex; rule skipped`
          );
        }
      }
    }
  }
  return { enforcement: { forbidPaths, forbidPatterns }, warnings };
};

/** Compiled repair-scope rules for the tool-argument repair pipeline. */
export interface CompiledRepairTools {
  regexes: RegExp[];
}

/**
 * Compile repair-scope rules into anchored, case-insensitive regexes via
 * `globToRegExp` — exact tool names and globs both work, and glob
 * compilation cannot throw.
 *
 * @param directives Parsed directives carrying optional `repair` rules.
 * @returns The compiled matcher set.
 */
export const compileRepairTools = (directives: Directive[]): CompiledRepairTools => {
  const regexes: RegExp[] = [];
  for (const directive of directives) {
    for (const rule of directive.repair ?? []) {
      regexes.push(globToRegExp(rule.tool));
    }
  }
  return { regexes };
};

/**
 * Whether a tool name matches any compiled repair-scope rule.
 *
 * @param compiled Output of {@link compileRepairTools}.
 * @param toolName Tool name from the hook input.
 * @returns True when the tool is directive-scoped for repair.
 */
export const matchRepairTools = (compiled: CompiledRepairTools, toolName: string): boolean =>
  compiled.regexes.some((regex) => regex.test(toolName));

export interface EnforcementVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * Evaluate compiled enforcement against a tool call (FR-028).
 * Paths match case-insensitively on the whole path or any
 * slash-boundary suffix (`matchesPaths`, FR-079); patterns match the
 * raw serialized arguments, case-insensitively. An empty rule set
 * never blocks. Block reasons name the directive, the match, and
 * the advisory text so the model can correct course (FR-012).
 */
export const evaluateEnforcement = (
  enforcement: CompiledEnforcement,
  toolName: string,
  rawArgs: string,
  argPaths: string[]
): EnforcementVerdict => {
  for (const rule of enforcement.forbidPaths) {
    const path = matchesPaths(rule.regex, argPaths);
    if (path !== undefined) {
      return {
        allowed: false,
        reason:
          `Tool '${toolName}' blocked by engineer directive '${rule.directiveId}': ` +
          `arguments touch forbidden path '${path}' (glob '${rule.glob}'). ${rule.text}`,
      };
    }
  }
  for (const rule of enforcement.forbidPatterns) {
    if (rule.regex.test(rawArgs)) {
      return {
        allowed: false,
        reason:
          `Tool '${toolName}' blocked by engineer directive '${rule.directiveId}': ` +
          `arguments match forbidden pattern '${rule.source}'. ${rule.text}`,
      };
    }
  }
  return { allowed: true, reason: '' };
};

/** One compiled `when` rule: a lowercased tool name and/or a compiled path glob. */
export interface CompiledTriggerRule {
  tool?: string;
  pathRegex?: RegExp;
}

/** The compiled `when` rules of one conditioned directive (FR-029). */
export interface CompiledTrigger {
  directiveId: string;
  rules: CompiledTriggerRule[];
}

/**
 * Compile `when` rules once at server start (FR-029): tool names are
 * lowercased and path globs compiled, so `matchTriggers` does no glob
 * compilation on the guarded-call hot path. Directives without `when`
 * rules are omitted — they are always active.
 *
 * @param directives The loaded directive set.
 * @returns The compiled triggers, in directive order.
 */
export const compileTriggers = (directives: Directive[]): CompiledTrigger[] =>
  directives
    .filter((directive) => (directive.when ?? []).length > 0)
    .map((directive) => ({
      directiveId: directive.id,
      rules: (directive.when ?? []).map((rule) => ({
        ...(rule.tool !== undefined ? { tool: rule.tool.toLowerCase() } : {}),
        ...(rule.path !== undefined ? { pathRegex: globToRegExp(rule.path) } : {}),
      })),
    }));

/**
 * Return the ids of directives whose `when` rules match the tool
 * call (FR-029): a rule matches when its tool name equals the call's
 * case-insensitively, or its path glob matches an argument path on
 * the whole path or a slash-boundary suffix (`matchesPaths`, FR-079).
 *
 * @param triggers Output of {@link compileTriggers}.
 * @param toolName The tool being invoked.
 * @param argPaths Path candidates from `extractDirectivePaths`.
 * @returns The triggered directive ids, in directive order.
 */
export const matchTriggers = (
  triggers: CompiledTrigger[],
  toolName: string,
  argPaths: string[]
): string[] => {
  const lowerTool = toolName.toLowerCase();
  return triggers
    .filter((trigger) =>
      trigger.rules.some(
        (rule) =>
          rule.tool === lowerTool ||
          (rule.pathRegex !== undefined && matchesPaths(rule.pathRegex, argPaths) !== undefined)
      )
    )
    .map((trigger) => trigger.directiveId);
};

/**
 * The memo-visible directive set (FR-029, FR-030): directives
 * without `when` rules are always active; conditioned directives
 * are active once triggered for the session.
 */
export const activeDirectives = (
  directives: Directive[],
  triggeredIds: string[]
): DirectiveText[] =>
  directives
    .filter(
      (directive) =>
        (directive.when ?? []).length === 0 || triggeredIds.includes(directive.id)
    )
    .map((directive) => ({ id: directive.id, text: directive.text }));

const renderBudgetedLines = (lines: string[], budget: number): string | null => {
  if (lines.length === 0) return null;
  let used = 0;
  const included: string[] = [];
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    included.push(line);
    used += line.length + 1;
  }
  if (included.length === lines.length) {
    return lines.join('\n');
  }
  const omitted = lines.length - included.length;
  return `${included.join('\n')}\n(${omitted} more directive${
    omitted === 1 ? '' : 's'
  } omitted — render budget of ${budget} characters)`;
};

/**
 * Render the memo `Directives:` section (FR-030): `- <id>: <text>`
 * lines, whole-line truncated to the aggregate render budget with a
 * truncation note (D8 — applies the Change B memo-design lesson).
 */
export const renderDirectives = (
  directives: DirectiveText[],
  budget = MAX_DIRECTIVES_RENDER_BUDGET
): string | null => {
  const body = renderBudgetedLines(
    directives.map((directive) => `- ${directive.id}: ${directive.text}`),
    budget
  );
  return body === null ? null : `Directives:\n${body}`;
};

/**
 * Render directives for the peer-audit prompt (FR-031): plain
 * `<id>: <text>` lines under the same render budget. Returns null
 * when there is nothing to audit against.
 */
export const renderDirectivesAdvisory = (
  directives: Directive[],
  budget = MAX_DIRECTIVES_RENDER_BUDGET
): string | null =>
  renderBudgetedLines(
    directives.map((directive) => `${directive.id}: ${directive.text}`),
    budget
  );
