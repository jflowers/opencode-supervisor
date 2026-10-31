/**
 * Tool Execution Intent Verifier
 * Prevents reward hacking, enforces engineer directives, and blocks
 * tool calls whose arguments contradict or are absent from the
 * verified reasoning trace. The trace check is best-effort (design
 * D5): when the verified trace is empty it MUST NOT block (FR-011)
 * — only the reward-hacking patterns still apply (FR-009).
 * Directive enforcement (FR-028) applies whenever compiled engineer
 * rules exist and never blocks when the rule set is empty. Block
 * reasons are actionable (FR-012): they name the failed check and,
 * for trace mismatches, the unmatched path. Pure module: no OpenCode
 * imports, no I/O.
 */

import { evaluateEnforcement, extractPolicyPaths, type CompiledEnforcement } from './directives.ts';
import type { AuditConfig } from './auditor.ts';
import { extractPathTokens, isPatternToken } from './path-tokens.ts';

export interface ToolVerificationResult {
  allowed: boolean;
  /** Corrective signal surfaced to the model on block (FR-012); informational when allowed. */
  reason: string;
}

/**
 * Reward-hacking marker set (FR-009): `--no-verify`, skipped-test markers,
 * tautological assertions, and test-directory deletion. Mirrors the marker
 * set in auditor.ts's deterministic invariants. `rawArgs` is the
 * JSON-serialized tool arguments and `lowerArgs` its lowercased form; the
 * rm -rf regex carries its own case-insensitive flag against rawArgs.
 *
 * @returns The matched marker so the block reason can name it (FR-012), or null when the arguments are clean.
 */
function matchRewardHackingMarker(rawArgs: string, lowerArgs: string): string | null {
  if (lowerArgs.includes('--no-verify')) {
    return '--no-verify';
  }
  if (lowerArgs.includes('.skip(')) {
    return '.skip(';
  }
  // Compared against lowerArgs, so `toBe` arrives lowercased.
  if (lowerArgs.includes('expect(true).tobe(true)')) {
    return 'expect(true).toBe(true)';
  }
  const deletedTests = /rm\s+-rf\s+tests?/i.exec(rawArgs);
  if (deletedTests) {
    return deletedTests[0];
  }
  return null;
}

/**
 * Extracts every file-path token from the tool arguments (FR-010,
 * FR-066): top-level string values scanned with the shared path-token
 * grammar — which since FR-066 recognizes wildcard- and
 * variable-bearing spans as pattern tokens, tokenizes `config.json`
 * whole (no `.js` prefix), and produces no phantom `id.md` from
 * `"$bdir/$id.md"`. Feeds the trace check. Engineer-directive
 * enforcement and triggers (FR-028, FR-029) use the broader
 * `extractPolicyPaths` instead — this extension allowlist cannot see
 * `.env` or extensionless paths.
 */
export function extractArgPaths(args: Record<string, unknown> | undefined): string[] {
  return Object.values(args || {})
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => extractPathTokens(v));
}

/**
 * Argument keys that carry document content rather than an
 * operational target (FR-061, FR-064). Values under these keys are
 * data the agent is writing — a mention there is not a touch — so
 * both the protected-state check and the trace check skip them for
 * non-bash tools (design D6: the round-4 lens). Every other key,
 * including custom/MCP key names like `target`, IS scanned:
 * coverage fails closed for unknown tools rather than narrowing to
 * a known-key allowlist (review round 4: an operational-key
 * allowlist had let a custom tool touch the approvals file
 * unblocked). The set does not grow per tool — `focus` and `text`
 * stay out; a per-tool except-list would open custom-tool evasion.
 * Payload keys beyond this blocklist (`text`, `body`, `document`,
 * `patch`, `diff`, `edits`, `data`) are still scanned for non-bash
 * tools and can false-positive — fail closed, the round-5 residual
 * class, accepted.
 */
const CONTENT_ARG_KEYS = ['content', 'oldString', 'newString'];

/**
 * Compiles a pattern token into an anchored full-path regular
 * expression (FR-066, design D4/D5): `$name` spans translate to a
 * within-segment wildcard first — the runtime value is unknown, and
 * the token must never demand the phantom literal it spells — then
 * each segment compiles through `globSegmentToRegExp` and the
 * segments join on literal slashes. Cross-segment `**` for variables
 * was rejected (any `.md` mention would satisfy any `$var/*.md`
 * call, dissolving the filename-level check).
 */
const globPathToRegExp = (token: string): RegExp => {
  const devaried = token.replace(/\$[a-zA-Z0-9_]+/g, '*');
  const segments = devaried
    .split('/')
    .map((segment) => globSegmentToRegExp(segment).source.replace(/^\^/, '').replace(/\$$/, ''));
  return new RegExp(`^${segments.join('\\/')}$`);
};

/**
 * Finds the first operational file path in the tool arguments that is
 * absent from the verified trace (FR-010, FR-064, FR-066). The lens
 * (design D6) matches the round-4 protected-state idiom: for tools
 * other than bash, values under the content keys (`content`,
 * `oldString`, `newString`) are authored data — a filename quoted
 * there is a mention, not a touch — while every other key, including
 * unknown and custom names like `target`, stays scanned (coverage
 * fails closed); bash command strings remain operational in full.
 * A concrete token counts as referenced when the trace contains either
 * the full token or its basename, case-insensitively. A pattern token
 * (glob metacharacters or `$var` spans — its runtime expansion is
 * unknown) counts as referenced when the trace contains the pattern
 * verbatim (the model reasoned in the same spelling) or names a path
 * the compiled pattern matches; the trace side extracts tokens with
 * the same grammar (design D3), so "reason about X" and "the guard
 * checks X" recognize the same X.
 *
 * @param toolName The tool being invoked (bash gets the raw lens).
 * @param args The tool call's arguments; only top-level string values carry paths.
 * @param verifiedSteps The session's verified reasoning trace (non-empty).
 * @returns The unmatched token — a pattern names itself, never a phantom
 *   expansion like `id.md` — for the block reason (FR-012), or null when
 *   every token is referenced.
 */
function findUnreferencedPath(
  toolName: string,
  args: Record<string, unknown> | undefined,
  verifiedSteps: string[]
): string | null {
  const combinedSteps = verifiedSteps.join(' ').toLowerCase();
  // FR-064 lens: authored content is data, never an operational touch.
  const lensedArgs =
    toolName === 'bash'
      ? args
      : Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !CONTENT_ARG_KEYS.includes(key)));
  const argPaths = extractArgPaths(lensedArgs);
  // Trace-side tokens, extracted lazily: only pattern satisfaction
  // needs them, and most calls carry none.
  let traceTokens: string[] | null = null;

  for (const fileToken of argPaths) {
    if (isPatternToken(fileToken)) {
      const lowered = fileToken.toLowerCase();
      if (combinedSteps.includes(lowered)) {
        continue;
      }
      traceTokens ??= verifiedSteps
        .flatMap((step) => extractPathTokens(step))
        .map((token) => token.toLowerCase());
      const pattern = globPathToRegExp(lowered);
      if (traceTokens.some((token) => pattern.test(token))) {
        continue;
      }
      return fileToken;
    }
    const base = fileToken.split('/').pop()?.toLowerCase() || fileToken.toLowerCase();
    if (!combinedSteps.includes(base) && !combinedSteps.includes(fileToken.toLowerCase())) {
      return fileToken;
    }
  }
  return null;
}

/**
 * Verifies a tool call's intent before execution (FR-009..FR-012).
 * Reward-hacking argument patterns block unconditionally when enabled
 * (FR-009). The file-path trace check is best-effort (design D5): it
 * applies only when a verified trace exists — an empty trace MUST NOT
 * block (FR-011). Blocked results carry an actionable reason naming the
 * failed check and, for trace mismatches, the unmatched path (FR-012).
 *
 * @param toolCall The tool name and arguments about to execute.
 * @param verifiedSteps Reasoning steps that passed audit (the session's verified trace).
 * @param config Flags gating the reward-hacking and trace checks.
 * @param enforcement Compiled engineer-directive rules (FR-028); absent or empty never blocks.
 * @param consoleTools Names of the plugin's own registered console tools (FR-065, design
 *   D7); these skip the file-path trace check — the channel that exists to keep the
 *   supervision loop open — while the reward-hacking check above still applies to them.
 *   Default none: fail-closed for direct callers, who pass the set derived from the
 *   registered tool map.
 * @returns The verdict; `reason` is the model's corrective signal when blocked.
 */
export function verifyToolIntent(
  toolCall: { name: string; arguments?: Record<string, unknown> },
  verifiedSteps: string[],
  config: Pick<AuditConfig, 'blockRewardHacking' | 'requireStepReferenceInTools'>,
  enforcement?: CompiledEnforcement,
  consoleTools?: ReadonlySet<string>
): ToolVerificationResult {
  const rawArgs = JSON.stringify(toolCall.arguments || {});
  const lowerArgs = rawArgs.toLowerCase();

  if (config.blockRewardHacking) {
    const marker = matchRewardHackingMarker(rawArgs, lowerArgs);
    if (marker) {
      return {
        allowed: false,
        reason: `Tool '${toolCall.name}' blocked by the reward-hacking check: arguments contain '${marker}'. Fix the underlying defect instead of weakening or bypassing tests.`,
      };
    }
  }

  // Engineer-directive enforcement (FR-028): applies whenever compiled
  // rules exist — the directive set itself is the gate, not a config
  // flag — and an empty rule set never blocks. Reasons name the
  // directive, the match, and the advisory text (FR-012).
  if (enforcement && (enforcement.forbidPaths.length > 0 || enforcement.forbidPatterns.length > 0)) {
    const directiveVerdict = evaluateEnforcement(
      enforcement,
      toolCall.name,
      rawArgs,
      extractPolicyPaths(toolCall.arguments)
    );
    if (!directiveVerdict.allowed) {
      return {
        allowed: false,
        reason: directiveVerdict.reason,
      };
    }
  }

  if (config.requireStepReferenceInTools) {
    // FR-065 (design D7): the plugin's own console tools skip the
    // file-path trace check — the review gate's corrective instruction
    // points at request_audit, so blocking that call on its own focus
    // text would fence the channel that exists to keep the loop open.
    // Derived from the registered tool map by the caller, so a future
    // console tool is exempt automatically. The reward-hacking check
    // above still applies unconditionally.
    if (consoleTools !== undefined && consoleTools.has(toolCall.name)) {
      return {
        allowed: true,
        reason: 'Console tool exempt from the file-path trace check; reward-hacking checks still applied.',
      };
    }
    // FR-011 / design D5: an empty trace means no audited reasoning exists
    // yet (first call, auditor unavailable, audit still in flight) — the
    // path check MUST NOT block; only the reward-hacking check above applies.
    if (verifiedSteps.length === 0) {
      return {
        allowed: true,
        reason: 'Verified trace empty; only reward-hacking checks applied.',
      };
    }

    const unmatchedPath = findUnreferencedPath(toolCall.name, toolCall.arguments, verifiedSteps);
    if (unmatchedPath) {
      // FR-012 / FR-066: the reason names the token as it was spelled.
      // A pattern token names itself — never a phantom expansion like
      // `id.md` — and points at the corrective action: reason about the
      // files it expands to, or name them concretely.
      const reason = isPatternToken(unmatchedPath)
        ? `Tool '${toolCall.name}' blocked by the file-path trace check: pattern '${unmatchedPath}' is not satisfied by the verified reasoning trace. Reason about the files the pattern expands to, or name them concretely, in verified steps, then retry.`
        : `Tool '${toolCall.name}' blocked by the file-path trace check: '${unmatchedPath}' is absent from the verified reasoning trace (no full-path or basename match). Reason about the file in verified steps, then retry.`;
      return {
        allowed: false,
        reason,
      };
    }
  }

  return {
    allowed: true,
    reason: 'Tool parameters align with the verified reasoning trace.',
  };
}

/**
 * Normalize a path token for protected-state matching (FR-061):
 * backslashes fold to slashes, empty and `.` segments drop, `..`
 * pops its parent — so traversal spellings like
 * `.opencode/supervisor/../supervisor/config.json` collapse onto
 * the protected path — and leading dots fold away, so the project
 * spelling (`.opencode/supervisor`) and the global one
 * (`~/.config/opencode/supervisor`) normalize identically (review
 * round 3: an exact-segment needle had left the project tier dead
 * code).
 */
export const normalizePathToken = (token: string): string => {
  const segments: string[] = [];
  for (const segment of token.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    const folded = segment.replace(/^\.+/, '').toLowerCase();
    if (folded !== '') {
      segments.push(folded);
    }
  }
  return segments.join('/');
};

/**
 * True when the normalized path contains `run` as a consecutive
 * segment run (FR-061): `a/directives-backup/b` does not match an
 * `opencode/supervisor/directives` run, but every path inside or
 * equal to that directory does. A single-segment run is exact
 * segment equality, so `stale-approvals.json` does not match
 * `approvals.json` (review round 4). Since review round 5, a segment
 * carrying shell glob metacharacters matches by glob semantics —
 * the shell expands `su*ervisor` and `app*vals.json` onto the
 * protected path at execution time, so exact equality alone was a
 * bypass.
 */
export const hasProtectedSegmentRun = (normalized: string, run: string): boolean => {
  const needle = run.split('/');
  const segments = normalized.split('/');
  for (let i = 0; i + needle.length <= segments.length; i += 1) {
    if (needle.every((needleSegment, j) => segmentMatches(segments[i + j], needleSegment))) {
      return true;
    }
  }
  return false;
};

/**
 * Compares one normalized path segment against one needle segment
 * (FR-061, review round 5): exact equality, or — when the segment
 * carries shell glob metacharacters — glob semantics where `*`
 * matches within a segment, `?` one character, and `[...]` a
 * character class.
 */
const segmentMatches = (segment: string, needleSegment: string): boolean =>
  segment === needleSegment || (/[*?[]/.test(segment) && globSegmentToRegExp(segment).test(needleSegment));

/**
 * Converts a glob-bearing path segment into an anchored regular
 * expression (review round 5): `*` becomes `[^/]*`, `?` becomes
 * `[^/]`, and a balanced bracket expression passes through with the
 * glob negation marker (`!`) translated to `^`. An unterminated
 * bracket is a literal `[`, as in bash; every other character is
 * regex-escaped.
 */
const globSegmentToRegExp = (segment: string): RegExp => {
  let pattern = '';
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) {
        pattern += '\\[';
      } else {
        let body = segment.slice(i + 1, close);
        if (body.startsWith('!')) {
          body = `^${body.slice(1)}`;
        }
        pattern += `[${body}]`;
        i = close;
      }
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
};

/**
 * Protected-state check (FR-061): returns the block reason when
 * the tool call touches engineer-authored supervisor state — the
 * approvals file, either supervisor config file, the directives
 * directory, or the supervisor state directory containing them —
 * and null when the call is allowed. Two lenses pair so evasion
 * spellings cannot slip past either. The path lens matches
 * lexically normalized tokens (traversal collapses, leading dots
 * fold away) and glob-bearing segments by glob semantics (review
 * round 5); for non-bash tools it scans every argument key
 * except the content keys above, so write/edit content is data,
 * never a touch, while custom key names stay covered. The raw
 * lens scans only bash command strings, capped at 64 KiB before
 * any transform — a command is an executable operation, so
 * mentions there are actionable, and the cap bounds allocation;
 * it catches slash-free spellings (`cd .opencode/supervisor &&
 * cat config.json`) the path extractor cannot tokenize (each bash
 * call is a fresh process, so a cd cannot persist across calls).
 * Block reasons name the protected object for the engineer, never
 * the spelling the agent used.
 *
 * @param toolName The tool being invoked.
 * @param args The tool call arguments.
 * @param argPaths Policy paths extracted from the full arguments;
 *   used as-is for bash (every token is operational) and ignored
 *   for other tools, which are re-filtered here minus content keys.
 * @returns The block reason, or null when the call is allowed.
 */
export const checkProtectedState = (
  toolName: string,
  args: Record<string, unknown> | undefined,
  argPaths: string[]
): string | null => {
  // Path lens: bash arguments are operational in full; other
  // tools carry their operation in path-like keys while content
  // keys hold data.
  const guardArgPaths =
    toolName === 'bash'
      ? argPaths
      : extractPolicyPaths(
          Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !CONTENT_ARG_KEYS.includes(key)))
        );
  const normalizedArgPaths = guardArgPaths.map(normalizePathToken);
  // Raw lens: the bash command string only, capped before
  // lowercasing so the scan cannot multiply a huge payload.
  const command = args?.command;
  const rawCommandLower =
    toolName === 'bash' && typeof command === 'string' ? command.slice(0, 65536).toLowerCase() : '';
  if (
    normalizedArgPaths.some((p) => hasProtectedSegmentRun(p, 'approvals.json')) ||
    // Review round 4: token-boundary matching — 'stale-approvals.json'
    // contains the substring but names a different file.
    /(?:^|[^a-z0-9_.-])approvals\.json/.test(rawCommandLower)
  ) {
    return 'the approvals file is engineer-authored state; the supervised agent may not touch it (engineer approval gates depend on it). Ask the engineer to update .opencode/supervisor/approvals.json.';
  }
  if (
    normalizedArgPaths.some((p) => hasProtectedSegmentRun(p, 'opencode/supervisor/config.json')) ||
    (rawCommandLower.includes('supervisor') && rawCommandLower.includes('config.json'))
  ) {
    return 'the supervisor config file is engineer-authored state; the supervised agent may not touch it (tool-guard toggles and the auditor model depend on it). Ask the engineer to edit the supervisor config.json directly.';
  }
  if (
    normalizedArgPaths.some((p) => hasProtectedSegmentRun(p, 'opencode/supervisor/directives')) ||
    (rawCommandLower.includes('supervisor') && rawCommandLower.includes('directives'))
  ) {
    return 'the supervisor directives are engineer-authored state; the supervised agent may not touch them (enforcement rules and gates depend on them). Ask the engineer to edit the directives directory directly.';
  }
  // Directory backstop (path lens only): an ancestor spelling
  // (`rm -rf .opencode/supervisor`) normalizes onto the run
  // itself. No raw pairing — the bare word 'supervisor' is too
  // common in command prose (documented residual in FR-061).
  if (normalizedArgPaths.some((p) => hasProtectedSegmentRun(p, 'opencode/supervisor'))) {
    return 'the supervisor state directory is engineer-authored state; the supervised agent may not touch it (engineer directives, gates, and configuration depend on it). Ask the engineer to edit the .opencode/supervisor directory directly.';
  }
  return null;
};
