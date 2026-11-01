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

/** Structured block cause (FR-067, design D8): which check blocked the call. */
export type BlockedCheck = 'reward-hacking' | 'directives' | 'trace';

export interface ToolVerificationResult {
  allowed: boolean;
  /** Corrective signal surfaced to the model on block (FR-012); informational when allowed. */
  reason: string;
  /**
   * Which check blocked the call (FR-067, design D8): set on every
   * blocked return, so block attribution is structured — never
   * prose-matched against free-form reasons (the `PeerAuditOutcome.source`
   * idiom). Absent when allowed.
   */
  blockedCheck?: BlockedCheck;
  /**
   * The unmatched path token (FR-070, design D4/D5): set on every
   * trace block so the hook layer can check in-flight audit coverage
   * without prose-matching the reason — the `blockedCheck` idiom.
   * Names the token as the guard spelled it.
   */
  unmatchedToken?: string;
  /**
   * True when the trace block came from a drained glob work budget
   * rather than a completed scan (review iteration 4): the reason
   * says the check could not complete — a distinct correction from a
   * genuine miss — and the hook layer logs the exhaustion. Absent
   * otherwise; the `blockedCheck` idiom.
   */
  budgetExhausted?: boolean;
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
 * Total, bounded glob matching for agent-authored path tokens
 * (FR-066, FR-069; review iteration-2 hardening, learnings
 * security-20261101T150645 / security-20261101T150647): the
 * matcher is a dynamic-programming evaluator, never a RegExp
 * compiled from untrusted input — a bracket body ending in a
 * backslash (`src/[\].md`) used to throw out of the guard into
 * the hook's blanket fail-open, and star-chain patterns could
 * drive catastrophic backtracking synchronously on the event
 * loop. Parsing follows POSIX glob semantics: `*` matches within
 * a segment (never a `/`), `?` one non-slash character, `[...]`
 * a character class with `-` ranges and `!`/`^` negation, and an
 * unterminated `[` is a literal, as in bash. Class bodies are
 * taken verbatim — a backslash inside a class is a literal
 * member, so no spelling can escape or crash the parse.
 *
 * Complexity bounds (learning security-20261031T210504): pattern
 * tokens are agent-authored and untrusted, so over-long or
 * wildcard-heavy patterns are rejected outright, and subjects are
 * capped as well — a within-bounds pattern against an over-long
 * subject matches nothing (fail closed on both sides). The
 * evaluator is O(pattern × subject) either way, so the bounds are
 * a semantic signal — distinct block reasons (FR-012) — not the
 * only defense against unbounded work.
 */
const MAX_GLOB_PATTERN_LENGTH = 512;
const MAX_GLOB_PATTERN_WILDCARDS = 32;
const MAX_GLOB_SUBJECT_LENGTH = 512;
/**
 * Defense-in-depth cap for protected-state segment matching, where
 * the subject is a short engineer-authored needle: bounds the
 * evaluator's cost by the pattern alone.
 */
const MAX_GLOB_SEGMENT_PATTERN_LENGTH = 4096;

type GlobToken =
  | { kind: 'literal'; char: string }
  | { kind: 'star' }
  | { kind: 'question' }
  | { kind: 'class'; negated: boolean; chars: Set<string> };

const countGlobWildcards = (devaried: string): number => {
  let wildcards = 0;
  for (const char of devaried) {
    if (char === '*' || char === '?' || char === '[') {
      wildcards += 1;
    }
  }
  return wildcards;
};

/**
 * Whether a devaried pattern exceeds the shared compiler's
 * complexity bounds. ONE predicate (review iteration 4): the
 * compiler below and the bound-rejection signal below it derive
 * from the same check, so the block reason can never misreport
 * what the compiler accepts.
 */
const exceedsGlobBounds = (devaried: string): boolean =>
  devaried.length > MAX_GLOB_PATTERN_LENGTH || countGlobWildcards(devaried) > MAX_GLOB_PATTERN_WILDCARDS;

/**
 * Whether a pattern token exceeds the shared compiler's complexity
 * bounds — the distinct bound-rejection signal for block reasons
 * (FR-012, review iteration 2): a rejected pattern must be
 * distinguishable from an unmatched one, because its corrective
 * action differs (name the files concretely, not reason in globs).
 */
export const isGlobPatternRejected = (token: string): boolean =>
  exceedsGlobBounds(token.replace(/\$[a-zA-Z0-9_]+/g, '*'));

const parseGlobPattern = (devaried: string): GlobToken[] => {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < devaried.length; i += 1) {
    const char = devaried[i];
    if (char === '*') {
      tokens.push({ kind: 'star' });
    } else if (char === '?') {
      tokens.push({ kind: 'question' });
    } else if (char === '[') {
      const close = devaried.indexOf(']', i + 1);
      if (close === -1) {
        // Unterminated bracket: a literal `[`, as in bash.
        tokens.push({ kind: 'literal', char: '[' });
      } else {
        let body = devaried.slice(i + 1, close);
        let negated = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          negated = true;
          body = body.slice(1);
        }
        const chars = new Set<string>();
        for (let b = 0; b < body.length; b += 1) {
          if (body[b] === '-' && b > 0 && b < body.length - 1) {
            const lo = body.charCodeAt(b - 1);
            const hi = body.charCodeAt(b + 1);
            if (lo <= hi) {
              for (let c = lo; c <= hi; c += 1) {
                chars.add(String.fromCharCode(c));
              }
              continue;
            }
          }
          chars.add(body[b]);
        }
        tokens.push({ kind: 'class', negated, chars });
        i = close;
      }
    } else {
      tokens.push({ kind: 'literal', char });
    }
  }
  return tokens;
};

/**
 * Counted work budget for one calling operation (review iteration
 * 3): every DP table reserves its cells against the budget, and a
 * drained budget fails closed — no coverage. The per-pattern caps
 * bound a single match, but the multiplication axes around it
 * (trace pattern tokens × call tokens × suffix positions) are all
 * agent-authored, so per-invocation caps alone left the TOTAL
 * unbounded (learning availability-20261101T160155). Review
 * iteration 4: every scanned PAIR charges the budget too — the
 * sweep itself, not only DP cells, is a multiplication axis an
 * adversary controls.
 */
export type GlobWorkBudget = { cellsRemaining: number };

const MAX_GLOB_BUDGET_CELLS = 4_000_000;

/**
 * Budget factory, exported for composition sites (review iteration
 * 4): the hook layer loops `isTokenCovered` over in-flight audit
 * boxes and must create exactly ONE budget per blocked call, not
 * one per box — the aggregate invariant holds only at the boundary
 * that owns the whole operation.
 */
export const createGlobBudget = (): GlobWorkBudget => ({ cellsRemaining: MAX_GLOB_BUDGET_CELLS });

/**
 * Devary + bounds-check + parse, once per pattern: the shared
 * pre-compilation step every match site goes through, so a
 * pattern is never re-devaried and re-parsed per subject or per
 * suffix (review iteration 3). Returns null when the pattern
 * exceeds the complexity bounds — it matches nothing, fail closed.
 */
const compileGlobPattern = (pattern: string): GlobToken[] | null => {
  const devaried = pattern.replace(/\$[a-zA-Z0-9_]+/g, '*');
  if (exceedsGlobBounds(devaried)) {
    return null;
  }
  return parseGlobPattern(devaried);
};

/**
 * O(pattern × subject) glob evaluation — an iterative DP over
 * suffix indexes, total by construction: no RegExp, no
 * backtracking, no throw. `*` consumes any run of non-slash
 * characters, `?` and classes consume exactly one non-slash
 * character — a class never consumes `/`, not even a negated one
 * (review iteration 3: the old `inClass !== negated` XOR let a
 * negated class eat the slash boundary) — and literals (including
 * `/`) consume themselves. The full first row is returned so one
 * pass answers every suffix start; null means the work budget
 * drained (fail closed).
 */
const globMatchTable = (tokens: readonly GlobToken[], subject: string, budget: GlobWorkBudget): Uint8Array | null => {
  const p = tokens.length;
  const s = subject.length;
  const width = s + 1;
  const cells = (p + 1) * width;
  if (cells > budget.cellsRemaining) {
    budget.cellsRemaining = 0;
    return null;
  }
  budget.cellsRemaining -= cells;
  // Flat row-major table (review iteration 4): dp[i * width + j]
  // holds whether tokens[i..] matches subject[j..]. One Uint8Array
  // instead of boxed per-row boolean arrays — ~4 MB of transient
  // allocation at the caps, not ~32.
  const dp = new Uint8Array(cells);
  dp[p * width + s] = 1;
  for (let i = p - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    const row = i * width;
    const next = (i + 1) * width;
    for (let j = s; j >= 0; j -= 1) {
      if (token.kind === 'star') {
        dp[row + j] = dp[next + j] === 1 || (j < s && subject[j] !== '/' && dp[row + j + 1] === 1) ? 1 : 0;
      } else if (j >= s) {
        dp[row + j] = 0;
      } else {
        const sc = subject[j];
        if (token.kind === 'question') {
          dp[row + j] = sc !== '/' && dp[next + j + 1] === 1 ? 1 : 0;
        } else if (token.kind === 'class') {
          const inClass = token.chars.has(sc);
          dp[row + j] = sc !== '/' && inClass !== token.negated && dp[next + j + 1] === 1 ? 1 : 0;
        } else {
          dp[row + j] = token.char === sc && dp[next + j + 1] === 1 ? 1 : 0;
        }
      }
    }
  }
  return dp.subarray(0, width);
};

/**
 * Full-path match: the pattern must cover the subject from index
 * 0, within the subject cap.
 */
const globTokensMatch = (tokens: readonly GlobToken[], subject: string, budget: GlobWorkBudget): boolean => {
  if (subject.length > MAX_GLOB_SUBJECT_LENGTH) {
    return false;
  }
  const starts = globMatchTable(tokens, subject, budget);
  return starts !== null && starts[0] === 1;
};

/**
 * Slash-boundary suffix match: the pattern matches subject[j..]
 * for j = 0 or any j just past a `/`, each suffix within the
 * subject cap — one DP pass instead of a re-run per boundary
 * (review iteration 3: the old suffix loop was O(pattern ×
 * subject²) per pair).
 */
const globTokensMatchAnySuffix = (tokens: readonly GlobToken[], subject: string, budget: GlobWorkBudget): boolean => {
  const starts = globMatchTable(tokens, subject, budget);
  if (starts === null) {
    return false;
  }
  const s = subject.length;
  if (s <= MAX_GLOB_SUBJECT_LENGTH && starts[0]) {
    return true;
  }
  for (let j = 1; j <= s; j += 1) {
    if (starts[j] && subject[j - 1] === '/' && s - j <= MAX_GLOB_SUBJECT_LENGTH) {
      return true;
    }
  }
  return false;
};

/**
 * Full-path glob match between an agent-authored pattern token
 * and an agent-authored subject (FR-066, design D4/D5): `$name`
 * spans devary to within-segment wildcards first — the runtime
 * value is unknown, and the token must never demand the phantom
 * literal it spells — then the total evaluator runs. Fails closed
 * on either complexity bound: a rejected pattern or an over-long
 * subject matches nothing. Cross-segment `**` for variables was
 * rejected (any `.md` mention would satisfy any `$var/*.md` call,
 * dissolving the filename-level check). Exported for direct
 * match-semantics testing (review iteration 3).
 */
export const globPathMatches = (pattern: string, subject: string, budget: GlobWorkBudget = createGlobBudget()): boolean => {
  const compiled = compileGlobPattern(pattern);
  if (compiled === null) {
    return false;
  }
  return globTokensMatch(compiled, subject, budget);
};

/**
 * Whether a trace-side pattern token satisfies a concrete call
 * token (FR-069, design D1/D2): the pattern must be path-scoped
 * (at least one `/` — a bare filename glob like `*.md` must not
 * dissolve the filename-level check, the mirror of the
 * cross-segment `**` rejection), and it must match the token's
 * full lowercased path or a slash-boundary suffix of it, bridging
 * absolute tool arguments against relative reasoning spellings.
 * A pattern rejected by the complexity bounds matches nothing —
 * fail closed, exactly as an unmatched pattern does.
 *
 * The pattern compiles once and a single DP pass answers every
 * slash-boundary suffix at once (row dp[0] holds match-by-start
 * for the whole subject; review iteration 3 — the old per-suffix
 * re-runs multiplied work by subject slash density). Budget
 * cells are charged against the caller's aggregate (one budget
 * per guard scan, not per pair), so pattern × token × suffix
 * multiplication cannot exceed MAX_GLOB_BUDGET_CELLS.
 */
const patternCoversToken = (pattern: string, loweredToken: string, budget: GlobWorkBudget): boolean => {
  if (!pattern.includes('/')) {
    return false;
  }
  const compiled = compileGlobPattern(pattern);
  if (compiled === null) {
    return false;
  }
  return globTokensMatchAnySuffix(compiled, loweredToken, budget);
};

/**
 * Whether a token is covered by candidate tokens from in-flight
 * audit step text (FR-070, design D3/D4): exact case-insensitive
 * equality (a verbatim spelling, concrete or pattern), basename
 * equality in either direction (the guard's own basename
 * satisfaction — a step naming just `notes.md` covers a call on
 * `kb/topics/notes.md`), a candidate the token's pattern matches
 * when the token is itself a pattern (the FR-066 direction), or a
 * path-scoped candidate pattern covering a concrete token (the
 * FR-069 direction). The hook layer uses this to relieve covered
 * waits without prose-matching block reasons.
 *
 * @param token The unmatched call token as the guard named it.
 * @param candidateTokens Path tokens of an in-flight audit's step text.
 * @param budget Aggregate work budget (review iteration 4): pass ONE
 *   per hook-layer operation when looping over in-flight audits; a
 *   drained budget fails closed (no coverage). Defaults to a fresh
 *   budget for direct callers.
 */
export function isTokenCovered(
  token: string,
  candidateTokens: readonly string[],
  budget: GlobWorkBudget = createGlobBudget()
): boolean {
  const lowered = token.toLowerCase();
  const loweredCandidates = candidateTokens.map((candidate) => candidate.toLowerCase());
  if (loweredCandidates.includes(lowered)) {
    return true;
  }
  // Basename equality (either direction) mirrors the guard's own
  // basename satisfaction: trace text naming `kb/topics/notes.md`
  // passes a call blocked on `notes.md`, so the pending audit's
  // step tokens must cover the same way.
  const base = lowered.split('/').pop() || lowered;
  if (loweredCandidates.some((candidate) => candidate.split('/').pop() === base)) {
    return true;
  }
  // One budget covers the whole check (review iterations 3 and 4):
  // every scanned pair is charged — not only DP cells — and callers
  // that loop over in-flight audits pass ONE budget for the whole
  // operation, the `globPathMatches` idiom (a fresh 4M budget per
  // box would multiply by pendingAudits.size).
  const chargePair = (): boolean => {
    if (budget.cellsRemaining <= 0) {
      return false;
    }
    budget.cellsRemaining -= 1;
    return true;
  };
  if (isPatternToken(lowered)) {
    const compiled = compileGlobPattern(lowered);
    if (compiled === null) {
      return false;
    }
    return loweredCandidates.some((candidate) => chargePair() && globTokensMatch(compiled, candidate, budget));
  }
  return loweredCandidates.some(
    (candidate) => chargePair() && isPatternToken(candidate) && patternCoversToken(candidate, lowered, budget)
  );
}

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
 * the full token or its basename, case-insensitively, or a path-scoped
 * trace pattern that covers it (FR-069). A pattern token
 * (glob metacharacters or `$var` spans — its runtime expansion is
 * unknown) counts as referenced when the trace contains the pattern
 * verbatim (the model reasoned in the same spelling) or names a path
 * the pattern matches; the trace side extracts tokens with
 * the same grammar (design D3), so "reason about X" and "the guard
 * checks X" recognize the same X.
 *
 * @param toolName The tool being invoked (bash gets the raw lens).
 * @param args The tool call's arguments; only top-level string values carry paths.
 * @param verifiedSteps The session's verified reasoning trace (non-empty).
 * @returns The unmatched token with its scan state — a pattern names
 *   itself, never a phantom expansion like `id.md` — for the block
 *   reason (FR-012), or null when every token is referenced.
 */
interface UnreferencedPathResult {
  /** The unmatched token, spelled as the guard saw it (FR-012). */
  fileToken: string;
  /**
   * True when the glob work budget drained before the scan finished
   * (review iteration 4): the block is fail-closed and the reason
   * must say the check could not complete — a distinct correction
   * from a genuine miss.
   */
  budgetExhausted: boolean;
}

function findUnreferencedPath(
  toolName: string,
  args: Record<string, unknown> | undefined,
  verifiedSteps: string[]
): UnreferencedPathResult | null {
  const combinedSteps = verifiedSteps.join(' ').toLowerCase();
  // FR-064 lens: authored content is data, never an operational touch.
  const lensedArgs =
    toolName === 'bash'
      ? args
      : Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => !CONTENT_ARG_KEYS.includes(key)));
  const argPaths = extractArgPaths(lensedArgs);
  // Trace-side tokens, extracted lazily and shared by both branches
  // (review iteration 4: the two duplicated lazy inits had drifted);
  // only pattern satisfaction needs them, and most calls carry none.
  let traceTokens: string[] | null = null;
  const getTraceTokens = (): string[] => {
    traceTokens ??= verifiedSteps
      .flatMap((step) => extractPathTokens(step))
      .map((token) => token.toLowerCase());
    return traceTokens;
  };
  // Pattern candidates partitioned once per scan (review iteration
  // 4): the concrete branch sweeps only pattern trace tokens, and
  // the per-call-token loop must not re-filter the whole trace on
  // every token.
  let tracePatternTokens: string[] | null = null;
  const getTracePatternTokens = (): string[] => {
    tracePatternTokens ??= getTraceTokens().filter((token) => isPatternToken(token));
    return tracePatternTokens;
  };
  // One glob budget covers the whole scan (review iterations 3 and
  // 4): trace patterns × call tokens × suffix positions are all
  // agent-authored axes, so the multiplication itself — not just
  // each single match — must be bounded and fail closed. Every
  // scanned PAIR charges the budget, not only DP cells: a
  // non-matching sweep over a dense trace is pure per-pair work,
  // and the 10 s trace wait is a Promise.race that cannot fire
  // during synchronous CPU.
  const globBudget = createGlobBudget();
  let budgetExhausted = false;
  const chargePair = (): boolean => {
    if (globBudget.cellsRemaining <= 0) {
      budgetExhausted = true;
      return false;
    }
    globBudget.cellsRemaining -= 1;
    return true;
  };

  for (const fileToken of argPaths) {
    if (isPatternToken(fileToken)) {
      const lowered = fileToken.toLowerCase();
      if (combinedSteps.includes(lowered)) {
        continue;
      }
      // A rejected pattern (complexity bounds) matches nothing:
      // it blocks naming itself, exactly as an unmatched pattern
      // does — the reason layer distinguishes it (FR-012).
      const compiled = compileGlobPattern(lowered);
      const covered =
        compiled !== null &&
        getTraceTokens().some((token) => chargePair() && globTokensMatch(compiled, token, globBudget));
      if (covered) {
        continue;
      }
      return { fileToken, budgetExhausted };
    }
    const lowered = fileToken.toLowerCase();
    const base = lowered.split('/').pop() || lowered;
    if (combinedSteps.includes(base) || combinedSteps.includes(lowered)) {
      continue;
    }
    // FR-069 (design D1/D2): a path-scoped trace pattern covers the
    // concrete token — glob-form reasoning satisfies the writes it
    // describes.
    const covered = getTracePatternTokens().some(
      (token) => chargePair() && patternCoversToken(token, lowered, globBudget)
    );
    if (covered) {
      continue;
    }
    return { fileToken, budgetExhausted };
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
        blockedCheck: 'reward-hacking',
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
        blockedCheck: 'directives',
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

    const unmatched = findUnreferencedPath(toolCall.name, toolCall.arguments, verifiedSteps);
    if (unmatched) {
      const unmatchedPath = unmatched.fileToken;
      // FR-012 / FR-066: the reason names the token as it was spelled.
      // A pattern token names itself — never a phantom expansion like
      // `id.md` — and points at the corrective action: reason about the
      // files it expands to, or name them concretely. A pattern rejected
      // by the complexity bounds says so distinctly (review iteration 2):
      // its corrective action differs — glob reasoning cannot scale to
      // that shape, so the files must be named.
      // FR-070 (design D6): the reason names both accepted
      // corrective forms and the settle-then-retry instruction —
      // honest in both audit states, so the guard stays pure.
      // Review iteration 4: a drained work budget is a third, distinct
      // diagnosis — the scan stopped early, so "absent from the trace"
      // would lie against a visible trace; the correction is concrete
      // naming, which needs no glob work.
      const reason = unmatched.budgetExhausted
        ? `Tool '${toolCall.name}' blocked by the file-path trace check: '${unmatchedPath}' could not be checked against the trace patterns — the matcher's work budget was exhausted by this session's trace volume before the scan completed (fail closed). Name the file concretely in verified steps — explicitly (full path or basename) — then retry once the audit settles.`
        : isPatternToken(unmatchedPath)
          ? isGlobPatternRejected(unmatchedPath)
            ? `Tool '${toolCall.name}' blocked by the file-path trace check: pattern '${unmatchedPath}' exceeds the compiler's complexity bounds (over ${MAX_GLOB_PATTERN_LENGTH} characters or ${MAX_GLOB_PATTERN_WILDCARDS} wildcards) and cannot be matched. Name the files it stands for concretely in verified steps, then retry once the audit settles.`
            : `Tool '${toolCall.name}' blocked by the file-path trace check: pattern '${unmatchedPath}' is not satisfied by the verified reasoning trace. Reason about the files the pattern expands to, or name them concretely, in verified steps, then retry once the audit settles.`
          : `Tool '${toolCall.name}' blocked by the file-path trace check: '${unmatchedPath}' is absent from the verified reasoning trace (no full-path, basename, or covering pattern match). Name the file in verified steps — explicitly (full path or basename) or with a path-scoped pattern like 'dir/*.md' — then retry once the audit settles rather than immediately in the same turn.`;
      return {
        allowed: false,
        reason,
        blockedCheck: 'trace',
        unmatchedToken: unmatchedPath,
        budgetExhausted: unmatched.budgetExhausted || undefined,
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
 * character class. Evaluation goes through the total DP matcher
 * (review iteration 2): the segment is agent-authored, so it is
 * never compiled into a RegExp. A segment beyond the
 * defense-in-depth length cap MATCHES (review iteration 3 — the
 * cap fails toward blocking): this is the protected-state check,
 * so absurd input must fail closed, not open.
 */
const segmentMatches = (segment: string, needleSegment: string): boolean => {
  if (segment === needleSegment) {
    return true;
  }
  if (!/[*?[]/.test(segment)) {
    return false;
  }
  if (segment.length > MAX_GLOB_SEGMENT_PATTERN_LENGTH) {
    return true;
  }
  return globTokensMatch(parseGlobPattern(segment), needleSegment, createGlobBudget());
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
