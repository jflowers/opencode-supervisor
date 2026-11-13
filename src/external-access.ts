/**
 * External-access supervision (FR-080..FR-089,
 * openspec/changes/external-access-scopes): pure detection of the
 * paths a tool call names outside the project root, access-class
 * classification, engineer grants (parse, coverage, expiry), the
 * gate decision, the `request_access` request and its relayed
 * `question` payload, reply matching for question-flow grants, and
 * the memo section. Lexical only — no filesystem access, no
 * symlink resolution (design D1). Reading the grants file, session
 * state, and the hooks live in index.ts.
 */

import { extractPolicyPaths } from './directives.ts';
import { expiryActive } from './gates.ts';
import { createGlobBudget, globPathMatches, type GlobWorkBudget } from './tool-guard.ts';

/** Access class of a tool call (FR-081). */
export type AccessClass = 'read' | 'write';

/** Scope of a grant: `read-write` covers both classes (FR-083). */
export type GrantMode = 'read' | 'read-write';

/** How external reads are treated (FR-082). */
export type ReadPolicy = 'allow' | 'gate';

/** Where a grant came from and how long it lasts (design D6). */
export type GrantLifetime = 'file' | 'session' | 'once';

/** The engineer's decision on a relayed question (design D7). */
export type AccessReply = 'once' | 'session' | 'persistent' | 'deny';

export const GRANT_MODES: readonly GrantMode[] = ['read', 'read-write'];
export const READ_POLICIES: readonly ReadPolicy[] = ['allow', 'gate'];

/** External-access configuration (FR-088). */
export interface ExternalAccessConfig {
  enabled: boolean;
  readPolicy: ReadPolicy;
}

/** Defaults: off, reads pass (FR-089). */
export const DEFAULT_EXTERNAL_ACCESS: ExternalAccessConfig = { enabled: false, readPolicy: 'allow' };

/** Where relative paths resolve and what counts as inside (design D1). */
export interface PathContext {
  /** Base directory for relative paths: the project directory. */
  base: string;
  /** Project roots; a path under any of them is internal. */
  roots: readonly string[];
  /** The home directory `~` and `$HOME` expand to. */
  home: string;
}

/** One grant (FR-083, FR-085). */
export interface ExternalGrant {
  /** Normalized absolute path or glob. */
  path: string;
  mode: GrantMode;
  lifetime: GrantLifetime;
  /** Request id the grant was minted from (question flow only). */
  requestId?: string;
  note?: string;
  /** YYYY-MM-DD; active through the end of that day, UTC. */
  expires?: string;
}

/** A pending `request_access` request (FR-084). */
export interface AccessRequest {
  id: string;
  path: string;
  mode: GrantMode;
  justification: string;
  /** The exact question text the plugin worded. */
  question: string;
}

/** The `question` tool's per-question shape (verified, design). */
export interface AccessQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiple: boolean;
  custom: boolean;
}

/** Gate decision (FR-082, FR-086). */
export interface ExternalAccessDecision {
  allowed: boolean;
  reason: string;
  /** External paths no grant covers. */
  uncovered: string[];
  /** Once grants the call would use; consumed only if the call proceeds. */
  onceGrantsUsed: ExternalGrant[];
}

/** Fixed caps (design D4, D6, D7, D9). */
export const MAX_EXTERNAL_GRANTS = 50;
export const MAX_EXTERNAL_GRANTS_FILE_BYTES = 64 * 1024;
export const MAX_SESSION_GRANTS = 20;
export const MAX_PENDING_ACCESS_REQUESTS = 10;
export const MAX_JUSTIFICATION_LENGTH = 300;
export const MAX_EXTERNAL_MEMO_LINES = 6;
/** Paths named in one block reason. */
const MAX_REASON_PATHS = 5;

/** The grants file, relative to the project directory (FR-083). */
export const EXTERNAL_GRANTS_FILE = '.opencode/supervisor/external-access.json';

/** Read-class builtins (FR-081, design D2). */
const READ_CLASS_TOOLS = ['read', 'glob', 'grep', 'list', 'lsp'];

/** Builtins that act on no file and are never gated (design D2). */
const GATE_NEUTRAL_TOOLS = [
  'question',
  'task',
  'todowrite',
  'todoread',
  'skill',
  'webfetch',
  'websearch',
  'codesearch',
];

/** Argument keys holding document content, not targets (FR-064). */
const CONTENT_KEYS = ['content', 'oldString', 'newString'];

/** Argument keys whose whole value is a path target (design D1). */
const TARGET_KEYS = ['filePath', 'path', 'file', 'filename', 'target', 'workdir'];

/** Device paths that touch no file (design D1). */
const DEVICE_PATHS = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty'];

const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`]*/g;
const TOKEN_SPLIT = /[\s'"`;|&<>()=,]+/;
const VARIABLE_TOKEN = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(.*)$/s;
const GLOB_CHARS = /[*?[]/;
const REQUEST_MARKER = /^\[supervisor access request (ax\d+)\]/;

export const REPLY_ONCE_LABEL = 'Allow once';
export const REPLY_SESSION_LABEL = 'Allow for this session';
export const REPLY_DENY_LABEL = 'Deny';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Access class of a tool (FR-081, design D2): the read-only
 * builtins are read-class; every other tool — bash, the editing
 * builtins, MCP and plugin tools — is write-class.
 */
export function classifyToolAccess(tool: string): AccessClass {
  return READ_CLASS_TOOLS.includes(tool) ? 'read' : 'write';
}

/** Whether a builtin acts on no file and is never gated (design D2). */
export function isGateNeutralTool(tool: string): boolean {
  return GATE_NEUTRAL_TOOLS.includes(tool);
}

/** Whether a call of this class needs a grant under the policy (FR-082). */
export function accessNeedsGrant(accessClass: AccessClass, readPolicy: ReadPolicy): boolean {
  return accessClass === 'write' || readPolicy === 'gate';
}

/**
 * Lexical normalization of an absolute path (design D1): empty and
 * `.` segments drop, `..` pops a segment but never above `/`, case
 * and leading dots are kept.
 */
export function normalizeAbsolutePath(absolute: string): string {
  const segments: string[] = [];
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** Whether a normalized path equals or lies under a directory. */
const isUnder = (normalized: string, directory: string): boolean =>
  directory === '/' || normalized === directory || normalized.startsWith(`${directory}/`);

/**
 * Resolve one path token to a normalized absolute path (design D1).
 * Returns the raw token when it cannot be resolved lexically and
 * may point anywhere (`~user`, an upper-case environment variable
 * path) — such a token is treated as external — and null when it
 * is not a path to check (a lower-case shell variable).
 */
export function resolvePathToken(token: string, base: string, home: string): string | null {
  const trimmed = token.trim();
  if (trimmed === '') return null;
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return normalizeAbsolutePath(`${home}/${trimmed.slice(1)}`);
  }
  if (trimmed.startsWith('~')) {
    return trimmed;
  }
  const variable = VARIABLE_TOKEN.exec(trimmed);
  if (variable !== null) {
    const name = variable[1] ?? variable[2] ?? '';
    const rest = variable[3] ?? '';
    if (rest !== '' && !rest.startsWith('/')) {
      return null;
    }
    if (name === 'HOME') return normalizeAbsolutePath(`${home}/${rest}`);
    if (name === 'PWD') return normalizeAbsolutePath(`${base}/${rest}`);
    // Inherited environment variables (upper case) point somewhere
    // unknown; shell-local ones must be assigned in the same command,
    // where their literal value is itself a token.
    if (/^[A-Z_][A-Z0-9_]*$/.test(name) && rest !== '') return trimmed;
    return null;
  }
  if (trimmed.startsWith('/')) {
    return normalizeAbsolutePath(trimmed);
  }
  return normalizeAbsolutePath(`${base}/${trimmed}`);
}

/** Whether a resolved path is outside every root (design D1). */
export function isExternalPath(resolved: string, roots: readonly string[]): boolean {
  if (!resolved.startsWith('/')) {
    return true;
  }
  if (DEVICE_PATHS.includes(resolved) || resolved.startsWith('/dev/fd/')) {
    return false;
  }
  return !roots.some((root) => isUnder(resolved, normalizeAbsolutePath(root)));
}

/** Path-candidate tokens from free text (design D1). */
const pathCandidates = (text: string): string[] => {
  const stripped = text.replace(URL_PATTERN, ' ');
  const split = stripped
    .split(TOKEN_SPLIT)
    .filter(
      (token) =>
        token !== '' &&
        (token.startsWith('/') ||
          token.startsWith('~') ||
          token.startsWith('$') ||
          token.startsWith('.') ||
          token.includes('/'))
    );
  return [...split, ...extractPolicyPaths({ text: stripped })];
};

/**
 * The external paths a tool call names (FR-080, design D1):
 * operational arguments only — bash `command` and `workdir`, or
 * every other string argument except content keys and grep's
 * `pattern`. Target keys are read whole; other values are
 * tokenized after URL removal. Returns distinct normalized
 * absolute paths (or raw unresolvable tokens) outside every root.
 */
export function findExternalPaths(
  tool: string,
  args: Record<string, unknown> | undefined,
  ctx: PathContext
): string[] {
  const values = args ?? {};
  let base = ctx.base;
  const wholeValues: string[] = [];
  const textValues: string[] = [];
  if (tool === 'bash') {
    if (typeof values.workdir === 'string' && values.workdir.trim() !== '') {
      wholeValues.push(values.workdir);
      const resolved = resolvePathToken(values.workdir, ctx.base, ctx.home);
      if (resolved !== null && resolved.startsWith('/')) {
        base = resolved;
      }
    }
    if (typeof values.command === 'string') {
      textValues.push(values.command);
    }
  } else {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string' || CONTENT_KEYS.includes(key)) continue;
      if (tool === 'grep' && key === 'pattern') continue;
      if (TARGET_KEYS.includes(key)) {
        if (!new RegExp(`^${URL_PATTERN.source}$`).test(value.trim())) {
          wholeValues.push(value);
        }
      } else {
        textValues.push(value);
      }
    }
  }
  const external: string[] = [];
  const seen = new Set<string>();
  const consider = (token: string, tokenBase: string): void => {
    const resolved = resolvePathToken(token, tokenBase, ctx.home);
    if (resolved === null || seen.has(resolved)) return;
    seen.add(resolved);
    if (isExternalPath(resolved, ctx.roots)) {
      external.push(resolved);
    }
  };
  for (const value of wholeValues) {
    consider(value, ctx.base);
  }
  for (const value of textValues) {
    for (const token of pathCandidates(value)) {
      consider(token, base);
    }
  }
  return external;
}

/**
 * Expand an engineer-written grant path (FR-083): `~`, `~/`,
 * `$HOME`, `${HOME}` expand to home; the result must be absolute.
 * Returns the normalized path, or null when it is not absolute.
 */
export function expandGrantPath(raw: string, home: string): string | null {
  const trimmed = raw.trim();
  let expanded = trimmed;
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    expanded = `${home}/${trimmed.slice(1)}`;
  } else if (/^\$\{?HOME\}?(?:\/|$)/.test(trimmed)) {
    expanded = `${home}/${trimmed.replace(/^\$\{?HOME\}?/, '')}`;
  }
  if (!expanded.startsWith('/')) return null;
  return normalizeAbsolutePath(expanded);
}

/**
 * Parse the grants file (FR-083, design D4): invalid JSON or a
 * non-array returns an error for the fail-closed path; malformed
 * entries are skipped; the most recent MAX_EXTERNAL_GRANTS kept.
 */
export function parseExternalGrants(
  raw: string,
  home: string
): { grants: ExternalGrant[]; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      grants: [],
      error: `grants file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { grants: [], error: 'grants file is not a JSON array' };
  }
  const grants: ExternalGrant[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue;
    if (!GRANT_MODES.includes(entry.mode as GrantMode)) continue;
    const grantPath = expandGrantPath(entry.path, home);
    if (grantPath === null) continue;
    const grant: ExternalGrant = { path: grantPath, mode: entry.mode as GrantMode, lifetime: 'file' };
    if (typeof entry.note === 'string' && entry.note.trim() !== '') grant.note = entry.note.trim();
    if (typeof entry.expires === 'string' && entry.expires.trim() !== '') grant.expires = entry.expires.trim();
    grants.push(grant);
  }
  return { grants: grants.slice(-MAX_EXTERNAL_GRANTS), error: null };
}

/**
 * Whether a grant path covers a resolved path (design D5): a
 * literal grant covers itself and its descendants; a glob grant
 * covers a path it matches or whose ancestor it matches, through
 * the total DP matcher.
 */
export function grantPathCovers(
  grantPath: string,
  resolved: string,
  budget: GlobWorkBudget = createGlobBudget()
): boolean {
  if (!resolved.startsWith('/')) return false;
  if (!GLOB_CHARS.test(grantPath)) {
    return isUnder(resolved, grantPath);
  }
  const segments = resolved.split('/').filter((segment) => segment !== '');
  for (let length = segments.length; length >= 1; length -= 1) {
    if (globPathMatches(grantPath, `/${segments.slice(0, length).join('/')}`, budget)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a grant covers a call on a path (FR-083, design D5):
 * active, a mode that allows the class (a read grant never covers
 * a write call), and a covering path.
 */
export function grantCovers(
  grant: ExternalGrant,
  resolved: string,
  accessClass: AccessClass,
  now: Date = new Date(),
  budget: GlobWorkBudget = createGlobBudget()
): boolean {
  if (!expiryActive(grant.expires, now)) return false;
  if (accessClass === 'write' && grant.mode !== 'read-write') return false;
  return grantPathCovers(grant.path, resolved, budget);
}

/** The grants-file record an engineer adds for a path (FR-083). */
export function grantFileRecord(grantPath: string, mode: GrantMode): string {
  return JSON.stringify({ path: grantPath, mode });
}

/**
 * The gate decision for a call's external paths (FR-082, FR-086,
 * design D3/D8): every path needs a covering grant; non-once
 * grants are preferred so a once grant is not spent needlessly. An
 * uncovered path blocks with an actionable reason — or, when the
 * grants file could not be read, with the error (fail closed).
 */
export function decideExternalAccess(input: {
  tool: string;
  accessClass: AccessClass;
  paths: readonly string[];
  grants: readonly ExternalGrant[];
  fileError: string | null;
  requestToolAvailable: boolean;
  now?: Date;
}): ExternalAccessDecision {
  const now = input.now ?? new Date();
  const budget = createGlobBudget();
  const lasting = input.grants.filter((grant) => grant.lifetime !== 'once');
  const once = input.grants.filter((grant) => grant.lifetime === 'once');
  const uncovered: string[] = [];
  const onceGrantsUsed: ExternalGrant[] = [];
  for (const resolved of input.paths) {
    if (lasting.some((grant) => grantCovers(grant, resolved, input.accessClass, now, budget))) continue;
    const onceGrant = once.find((grant) => grantCovers(grant, resolved, input.accessClass, now, budget));
    if (onceGrant !== undefined) {
      if (!onceGrantsUsed.includes(onceGrant)) onceGrantsUsed.push(onceGrant);
      continue;
    }
    uncovered.push(resolved);
  }
  if (uncovered.length === 0) {
    return { allowed: true, reason: '', uncovered, onceGrantsUsed };
  }
  const mode: GrantMode = input.accessClass === 'write' ? 'read-write' : 'read';
  const named = uncovered.slice(0, MAX_REASON_PATHS);
  const more = uncovered.length > named.length ? ` (and ${uncovered.length - named.length} more)` : '';
  const head = `Tool '${input.tool}' blocked by external-access supervision: ${input.accessClass} access to ${named.join(', ')}${more} outside the project root`;
  if (input.fileError !== null) {
    return {
      allowed: false,
      reason: `${head} has no session grant, and the grants file could not be read (${input.fileError}); external access fails closed. Ask the engineer to fix ${EXTERNAL_GRANTS_FILE}, then retry.`,
      uncovered,
      onceGrantsUsed: [],
    };
  }
  const first = named[0] ?? '';
  if (!first.startsWith('/')) {
    return {
      allowed: false,
      reason: `${head} cannot be resolved to an absolute path lexically (home-relative user or environment variable). Spell the path absolutely, then request access or retry.`,
      uncovered,
      onceGrantsUsed: [],
    };
  }
  const requestRemedy = input.requestToolAvailable
    ? `Call request_access with {"path": "${first}", "mode": "${mode}", "justification": "<why>"} and relay the question it returns to the engineer, or ask`
    : 'Ask';
  return {
    allowed: false,
    reason: `${head} needs an engineer grant. ${requestRemedy} the engineer to add ${grantFileRecord(first, mode)} to ${EXTERNAL_GRANTS_FILE}, then retry.`,
    uncovered,
    onceGrantsUsed: [],
  };
}

/**
 * Validate a `request_access` call (FR-084, design D7). Returns
 * the resolved request fields, or an actionable error.
 */
export function prepareAccessRequest(
  args: { path?: unknown; mode?: unknown; justification?: unknown } | undefined,
  ctx: PathContext
): { ok: true; path: string; mode: GrantMode; justification: string } | { ok: false; error: string } {
  const mode = args?.mode;
  if (typeof mode !== 'string' || !GRANT_MODES.includes(mode as GrantMode)) {
    return { ok: false, error: `Unknown mode "${String(mode)}" — use read or read-write.` };
  }
  const rawPath = typeof args?.path === 'string' ? args.path.trim() : '';
  if (rawPath === '') {
    return { ok: false, error: 'Path is empty — name the file or directory outside the project root.' };
  }
  const justification =
    typeof args?.justification === 'string' ? args.justification.replace(/\s+/g, ' ').trim() : '';
  if (justification === '') {
    return { ok: false, error: 'Justification is empty — state why the task needs this access.' };
  }
  const resolved = resolvePathToken(rawPath, ctx.base, ctx.home);
  if (resolved === null || !resolved.startsWith('/')) {
    return { ok: false, error: `Path "${rawPath}" cannot be resolved lexically — spell it as an absolute path.` };
  }
  if (!isExternalPath(resolved, ctx.roots)) {
    return { ok: false, error: `Path ${resolved} is inside the project root — no grant is needed.` };
  }
  if (resolved === '/' || resolved === normalizeAbsolutePath(ctx.home)) {
    return {
      ok: false,
      error: `Path ${resolved} is too broad to request through a question — name a narrower path, or ask the engineer to add a grant to ${EXTERNAL_GRANTS_FILE} directly.`,
    };
  }
  return {
    ok: true,
    path: resolved,
    mode: mode as GrantMode,
    justification:
      justification.length > MAX_JUSTIFICATION_LENGTH
        ? `${justification.slice(0, MAX_JUSTIFICATION_LENGTH - 1)}…`
        : justification,
  };
}

/** The plugin-worded question text for a request (design D7). */
export function accessQuestionText(id: string, requestPath: string, mode: GrantMode, justification: string): string {
  return `[supervisor access request ${id}] The agent requests ${mode.toUpperCase()} access outside the project root: ${requestPath}. Justification: ${justification} Grant it?`;
}

/**
 * The exact `question` tool question for a request (FR-084,
 * design D7): fixed option labels, a single choice, no free text.
 */
export function buildAccessQuestion(request: AccessRequest): AccessQuestion {
  const scope = request.mode === 'read' ? 'read' : 'read and write';
  return {
    question: request.question,
    header: `External access ${request.id}`,
    options: [
      { label: REPLY_ONCE_LABEL, description: `Allow one ${scope} call on ${request.path}` },
      { label: REPLY_SESSION_LABEL, description: `Allow ${scope} under ${request.path} for this session` },
      { label: REPLY_DENY_LABEL, description: 'Refuse the request' },
    ],
    multiple: false,
    custom: false,
  };
}

/**
 * Map an engineer's answer to a decision (design D7): deny words
 * first (fail-safe), then once, session, persistent. Anything else
 * — including `Unanswered` — decides nothing.
 */
export function parseAccessReply(answer: readonly string[]): AccessReply | null {
  const text = answer.join(' ').toLowerCase();
  if (/\b(deny|denied|reject|rejected|no)\b/.test(text)) return 'deny';
  if (/\bonce\b/.test(text)) return 'once';
  if (/\bsession\b/.test(text)) return 'session';
  if (/\b(always|persist|persistent|permanent|permanently)\b/.test(text)) return 'persistent';
  return null;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The answer for one question from the tool's output text (verified format). */
const answerFromOutputText = (outputText: string, questionText: string): string[] => {
  const needle = `"${questionText}"="`;
  const index = outputText.indexOf(needle);
  if (index === -1) return [];
  const start = index + needle.length;
  const end = outputText.indexOf('"', start);
  if (end === -1) return [];
  return outputText
    .slice(start, end)
    .split(', ')
    .filter((part) => part !== '');
};

/**
 * Match a completed `question` call against pending requests
 * (FR-085, design D7). Each question carrying a pending request's
 * marker yields a match; a question whose text differs from the
 * stored text is marked edited and decides nothing. Answers come
 * from `metadata.answers`, else from the output text.
 */
export function matchQuestionReplies(
  args: unknown,
  output: unknown,
  pending: readonly AccessRequest[]
): { request: AccessRequest; reply: AccessReply | null; edited: boolean }[] {
  if (!isRecord(args) || !Array.isArray(args.questions)) return [];
  const outputRecord = isRecord(output) ? output : {};
  const metadata = isRecord(outputRecord.metadata) ? outputRecord.metadata : {};
  const metadataAnswers = Array.isArray(metadata.answers) ? metadata.answers : undefined;
  const outputText = typeof outputRecord.output === 'string' ? outputRecord.output : '';
  const matches: { request: AccessRequest; reply: AccessReply | null; edited: boolean }[] = [];
  args.questions.forEach((question: unknown, index: number) => {
    if (!isRecord(question) || typeof question.question !== 'string') return;
    const marker = REQUEST_MARKER.exec(question.question.trim());
    if (marker === null) return;
    const request = pending.find((candidate) => candidate.id === marker[1]);
    if (request === undefined) return;
    if (collapse(question.question) !== collapse(request.question)) {
      matches.push({ request, reply: null, edited: true });
      return;
    }
    const fromMetadata = metadataAnswers?.[index];
    const answer = Array.isArray(fromMetadata)
      ? fromMetadata.filter((value): value is string => typeof value === 'string')
      : answerFromOutputText(outputText, question.question);
    matches.push({ request, reply: parseAccessReply(answer), edited: false });
  });
  return matches;
}

/** Append bounded to the most recent `cap` entries. */
export function appendRecent<T>(items: readonly T[], item: T, cap: number): T[] {
  const next = [...items, item];
  return cap <= 0 ? [] : next.slice(-cap);
}

/**
 * The memo's external-access section (FR-087, design D9): grants
 * and pending requests, at most `cap` lines (most recent kept),
 * or null when there is nothing to show.
 */
export function renderExternalAccess(
  grants: readonly ExternalGrant[],
  pending: readonly AccessRequest[],
  cap: number = MAX_EXTERNAL_MEMO_LINES
): string | null {
  const lines = [
    ...grants.map((grant) => `- granted ${grant.mode} ${grant.path} (${grant.lifetime})`),
    ...pending.map(
      (request) => `- pending ${request.id}: ${request.mode} ${request.path} — relay the question from request_access`
    ),
  ];
  if (lines.length === 0 || cap <= 0) return null;
  return `External access (outside the project root; writes need an engineer grant):\n${lines.slice(-cap).join('\n')}`;
}
