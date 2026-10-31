/**
 * Shared path-token grammar (FR-066, design D3) for the tool guard
 * and the narrative stripper: one definition of "this text mentions a
 * file path", so the corrective loop closes by construction — the
 * step text that satisfies the guard is exactly the step text the
 * stripper keeps. Pure leaf module: imports nothing, no I/O; the
 * guard and stripper both import it (convention AP-006, no cycles).
 *
 * Grammar: a run of path characters (letters, digits, `_`, `.`, `-`,
 * `/`, and the pattern characters `*`, `?`, `[`, `]`, `$`) ending in
 * a known source/config extension. The trailing boundary forbids a
 * continuation by any path character except `.` — so `config.json`
 * tokenizes whole (the alternation backtracks past the `js` prefix
 * match because `o` continues it) while a sentence-final period
 * after a path still tokenizes (`see src/a.ts.` yields `src/a.ts`).
 * The extension allowlist is unchanged from the round-1 grammar; its
 * boundary is a requirement-scope decision already documented in the
 * spec-accuracy learning, and widening it is not part of these
 * repairs.
 */

/** Path characters a token may span, including glob/variable markers (FR-066). */
const TOKEN_CHARS = 'a-zA-Z0-9_.*?$\\[\\]\\/-';

/**
 * File-path token (FR-010/FR-066): a path-character run ending in a
 * known source/config extension, digit- and pattern-bounded on both
 * ends. Declared per call site (module-level `g` regexes share a
 * match cursor across calls).
 */
const PATH_TOKEN_PATTERN = new RegExp(
  `[${TOKEN_CHARS}]+\\.(?:ts|tsx|js|json|py|md|sql|sh)(?![a-zA-Z0-9_*?$\\[\\]\\/-])`,
  'g'
);

/** Glob metacharacters and the shell-variable marker (FR-066, design D4/D5). */
const PATTERN_CHARS = /[*?$\[]/;

/**
 * Extracts every file-path token from free text (FR-066): both tool
 * arguments and verified reasoning steps feed this, so pattern
 * satisfaction compares tokens from the same grammar.
 *
 * @param text Any text — a tool argument value or a reasoning step.
 * @returns The distinct path tokens in order of first appearance.
 */
export function extractPathTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN_PATTERN)) {
    if (!tokens.includes(match[0])) {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

/**
 * Whether the text mentions any file-path token (FR-066): the
 * stripper's survival predicate — a step naming a path is formal
 * content and must survive narrative stripping, or the guard's
 * trace check can never be satisfied.
 *
 * @param text The reasoning step text.
 */
export function hasPathToken(text: string): boolean {
  PATH_TOKEN_PATTERN.lastIndex = 0;
  return PATH_TOKEN_PATTERN.test(text);
}

/**
 * Whether a path token is a pattern (FR-066, design D4/D5): glob
 * metacharacters (`*`, `?`, `[`) or a shell-variable marker (`$`)
 * make the token's runtime expansion unknown, so it matches by
 * pattern semantics rather than full-path/basename equality.
 *
 * @param token A token produced by `extractPathTokens`.
 */
export function isPatternToken(token: string): boolean {
  return PATTERN_CHARS.test(token);
}
