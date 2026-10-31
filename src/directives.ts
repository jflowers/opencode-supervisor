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

const normalizeEnforcementRules = (
  raw: unknown
): { rules: EnforcementRule[]; dropped: number } => {
  if (raw === undefined || raw === null) return { rules: [], dropped: 0 };
  if (!Array.isArray(raw)) return { rules: [], dropped: 1 };
  const rules: EnforcementRule[] = [];
  let dropped = 0;
  for (const entry of raw.slice(0, MAX_RULES_PER_DIRECTIVE)) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const rule: EnforcementRule = {};
    if (typeof record.forbidPath === 'string' && record.forbidPath.trim().length > 0) {
      rule.forbidPath = record.forbidPath.trim();
    }
    if (typeof record.forbidPattern === 'string' && record.forbidPattern.trim().length > 0) {
      rule.forbidPattern = record.forbidPattern.trim();
    }
    if (rule.forbidPath === undefined && rule.forbidPattern === undefined) {
      dropped += 1;
      continue;
    }
    rules.push(rule);
  }
  if (raw.length > MAX_RULES_PER_DIRECTIVE) {
    dropped += raw.length - MAX_RULES_PER_DIRECTIVE;
  }
  return { rules, dropped };
};

const normalizeTriggerRules = (
  raw: unknown
): { rules: TriggerRule[]; dropped: number } => {
  if (raw === undefined || raw === null) return { rules: [], dropped: 0 };
  if (!Array.isArray(raw)) return { rules: [], dropped: 1 };
  const rules: TriggerRule[] = [];
  let dropped = 0;
  for (const entry of raw.slice(0, MAX_RULES_PER_DIRECTIVE)) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const rule: TriggerRule = {};
    if (typeof record.tool === 'string' && record.tool.trim().length > 0) {
      rule.tool = record.tool.trim();
    }
    if (typeof record.path === 'string' && record.path.trim().length > 0) {
      rule.path = record.path.trim();
    }
    if (rule.tool === undefined && rule.path === undefined) {
      dropped += 1;
      continue;
    }
    rules.push(rule);
  }
  if (raw.length > MAX_RULES_PER_DIRECTIVE) {
    dropped += raw.length - MAX_RULES_PER_DIRECTIVE;
  }
  return { rules, dropped };
};

/**
 * Normalize `approve` gate rules (FR-043, design D7): strings are
 * trimmed; a rule needs at least one of tool/path/pattern (an empty
 * rule would match every call) and is dropped otherwise.
 */
const normalizeApproveRules = (
  raw: unknown
): { rules: ApproveRule[]; dropped: number } => {
  if (raw === undefined || raw === null) return { rules: [], dropped: 0 };
  if (!Array.isArray(raw)) return { rules: [], dropped: 1 };
  const rules: ApproveRule[] = [];
  let dropped = 0;
  for (const entry of raw.slice(0, MAX_RULES_PER_DIRECTIVE)) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const rule: ApproveRule = {};
    if (typeof record.id === 'string' && record.id.trim().length > 0) {
      rule.id = record.id.trim();
    }
    if (typeof record.tool === 'string' && record.tool.trim().length > 0) {
      rule.tool = record.tool.trim();
    }
    if (typeof record.path === 'string' && record.path.trim().length > 0) {
      rule.path = record.path.trim();
    }
    if (typeof record.pattern === 'string' && record.pattern.trim().length > 0) {
      rule.pattern = record.pattern.trim();
    }
    if (rule.tool === undefined && rule.path === undefined && rule.pattern === undefined) {
      dropped += 1;
      continue;
    }
    rules.push(rule);
  }
  if (raw.length > MAX_RULES_PER_DIRECTIVE) {
    dropped += raw.length - MAX_RULES_PER_DIRECTIVE;
  }
  return { rules, dropped };
};

/**
 * Normalize `review` gate rules (FR-047, design D7): a rule is a
 * path glob and nothing else — a review rule without a path is
 * meaningless and is dropped.
 */
const normalizeReviewRules = (
  raw: unknown
): { rules: ReviewRule[]; dropped: number } => {
  if (raw === undefined || raw === null) return { rules: [], dropped: 0 };
  if (!Array.isArray(raw)) return { rules: [], dropped: 1 };
  const rules: ReviewRule[] = [];
  let dropped = 0;
  for (const entry of raw.slice(0, MAX_RULES_PER_DIRECTIVE)) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== 'string' || record.path.trim().length === 0) {
      dropped += 1;
      continue;
    }
    rules.push({ path: record.path.trim() });
  }
  if (raw.length > MAX_RULES_PER_DIRECTIVE) {
    dropped += raw.length - MAX_RULES_PER_DIRECTIVE;
  }
  return { rules, dropped };
};

/**
 * Normalize `repair` scope rules: a rule is a tool name or glob and
 * nothing else — a repair rule without a tool is meaningless and is
 * dropped.
 */
const normalizeRepairRules = (
  raw: unknown
): { rules: RepairRule[]; dropped: number } => {
  if (raw === undefined || raw === null) return { rules: [], dropped: 0 };
  if (!Array.isArray(raw)) return { rules: [], dropped: 1 };
  const rules: RepairRule[] = [];
  let dropped = 0;
  for (const entry of raw.slice(0, MAX_RULES_PER_DIRECTIVE)) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.tool !== 'string' || record.tool.trim().length === 0) {
      dropped += 1;
      continue;
    }
    rules.push({ tool: record.tool.trim() });
  }
  if (raw.length > MAX_RULES_PER_DIRECTIVE) {
    dropped += raw.length - MAX_RULES_PER_DIRECTIVE;
  }
  return { rules, dropped };
};

/**
 * Parse directive files (FR-026, FR-027). Each file's markdown body
 * is the advisory text; the first ```supervisor-fenced block holds a
 * JSON rules object. The file id is the filename without `.md`.
 * Malformed files are skipped with a warning (fail-open).
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
    const trimmedText = text.trim();
    if (trimmedText.length > MAX_DIRECTIVE_TEXT) {
      warnings.push(
        `directive '${id}' advisory text truncated from ${trimmedText.length} to ${MAX_DIRECTIVE_TEXT} characters`
      );
    }
    const trimmed = trimmedText.slice(0, MAX_DIRECTIVE_TEXT);
    const enforce = normalizeEnforcementRules(rawRules.enforce);
    const when = normalizeTriggerRules(rawRules.when);
    const approve = normalizeApproveRules(rawRules.approve);
    const review = normalizeReviewRules(rawRules.review);
    const repair = normalizeRepairRules(rawRules.repair);
    if (enforce.dropped > 0) {
      warnings.push(
        `directive '${id}': ${enforce.dropped} enforce rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (when.dropped > 0) {
      warnings.push(
        `directive '${id}': ${when.dropped} when rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (approve.dropped > 0) {
      warnings.push(
        `directive '${id}': ${approve.dropped} approve rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (review.dropped > 0) {
      warnings.push(
        `directive '${id}': ${review.dropped} review rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (repair.dropped > 0) {
      warnings.push(
        `directive '${id}': ${repair.dropped} repair rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (
      !trimmed &&
      enforce.rules.length === 0 &&
      when.rules.length === 0 &&
      approve.rules.length === 0 &&
      review.rules.length === 0 &&
      repair.rules.length === 0
    ) {
      warnings.push(
        `directive file '${file.name}' has neither advisory text nor rules; file skipped`
      );
      continue;
    }
    directives.push({
      id,
      text: trimmed,
      ...(enforce.rules.length > 0 ? { enforce: enforce.rules } : {}),
      ...(when.rules.length > 0 ? { when: when.rules } : {}),
      ...(approve.rules.length > 0 ? { approve: approve.rules } : {}),
      ...(review.rules.length > 0 ? { review: review.rules } : {}),
      ...(repair.rules.length > 0 ? { repair: repair.rules } : {}),
    });
  }
  return { directives, warnings };
};

/**
 * Parse the `options.directives` array from tuple plugin
 * registration (FR-026). Same validation as files; entries without
 * an id get `d<index>`.
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
    const id =
      typeof record.id === 'string' && record.id.trim().length > 0
        ? record.id.trim()
        : `d${index + 1}`;
    const rawText = typeof record.text === 'string' ? record.text.trim() : '';
    if (rawText.length > MAX_DIRECTIVE_TEXT) {
      warnings.push(
        `directive '${id}' advisory text truncated from ${rawText.length} to ${MAX_DIRECTIVE_TEXT} characters`
      );
    }
    const text = rawText.slice(0, MAX_DIRECTIVE_TEXT);
    const enforce = normalizeEnforcementRules(record.enforce);
    const when = normalizeTriggerRules(record.when);
    const approve = normalizeApproveRules(record.approve);
    const review = normalizeReviewRules(record.review);
    const repair = normalizeRepairRules(record.repair);
    if (enforce.dropped > 0) {
      warnings.push(
        `directive '${id}': ${enforce.dropped} enforce rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (when.dropped > 0) {
      warnings.push(
        `directive '${id}': ${when.dropped} when rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (approve.dropped > 0) {
      warnings.push(
        `directive '${id}': ${approve.dropped} approve rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (review.dropped > 0) {
      warnings.push(
        `directive '${id}': ${review.dropped} review rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (repair.dropped > 0) {
      warnings.push(
        `directive '${id}': ${repair.dropped} repair rule(s) skipped (invalid or beyond the cap of ${MAX_RULES_PER_DIRECTIVE})`
      );
    }
    if (
      !text &&
      enforce.rules.length === 0 &&
      when.rules.length === 0 &&
      approve.rules.length === 0 &&
      review.rules.length === 0 &&
      repair.rules.length === 0
    ) {
      warnings.push(`options.directives[${index}] ('${id}') has neither text nor rules; skipped`);
      return;
    }
    directives.push({
      id,
      text,
      ...(enforce.rules.length > 0 ? { enforce: enforce.rules } : {}),
      ...(when.rules.length > 0 ? { when: when.rules } : {}),
      ...(approve.rules.length > 0 ? { approve: approve.rules } : {}),
      ...(review.rules.length > 0 ? { review: review.rules } : {}),
      ...(repair.rules.length > 0 ? { repair: repair.rules } : {}),
    });
  });
  return { directives, warnings };
};

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
 * Paths match case-insensitively on the full path or the basename;
 * patterns match the raw serialized arguments, case-insensitively.
 * An empty rule set
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
    for (const path of argPaths) {
      const basename = path.split('/').pop() ?? path;
      if (rule.regex.test(path) || rule.regex.test(basename)) {
        return {
          allowed: false,
          reason:
            `Tool '${toolName}' blocked by engineer directive '${rule.directiveId}': ` +
            `arguments touch forbidden path '${path}' (glob '${rule.glob}'). ${rule.text}`,
        };
      }
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

/**
 * Return the ids of directives whose `when` rules match the tool
 * call (FR-029): tool names compare case-insensitively; path globs
 * match any extracted argument path on the full path or basename,
 * case-insensitively. Directives without `when` rules never trigger
 * here — they are always active.
 */
export const matchTriggers = (
  directives: Directive[],
  toolName: string,
  argPaths: string[]
): string[] => {
  const lowerTool = toolName.toLowerCase();
  return directives
    .filter((directive) => {
      const rules = directive.when ?? [];
      return rules.some((rule) => {
        if (rule.tool !== undefined && rule.tool.toLowerCase() === lowerTool) {
          return true;
        }
        if (rule.path !== undefined) {
          const regex = globToRegExp(rule.path);
          return argPaths.some((path) => {
            const basename = path.split('/').pop() ?? path;
            return regex.test(path) || regex.test(basename);
          });
        }
        return false;
      });
    })
    .map((directive) => directive.id);
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
