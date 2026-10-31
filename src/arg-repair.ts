/**
 * Tool-Argument Repair
 *
 * Detects and repairs malformed tool-call arguments before execution — the
 * failure mode observed on providers that garble nested arrays-of-objects
 * (null in a required field, JSON stringified into a string value, an array
 * split across fragment objects). Validation uses a lenient JSON-schema
 * subset (unknown keywords pass, anyOf/oneOf pass when any branch passes)
 * so well-formed calls are never flagged. Deterministic structural repairs
 * run first and are gated by re-validation; the model tier runs only when
 * structure alone cannot recover the arguments, receives the tool schema,
 * the emitted arguments, the validation issues, and assistant reasoning
 * evidence, and is forbidden from inventing substantive content. Every
 * model-tier candidate is re-validated before it is accepted. All failures
 * fail open: the caller leaves the original arguments untouched and
 * OpenCode's normal schema error reaches the model.
 */

export type SupervisorMode = 'full' | 'repair-only';

/** Valid `mode` values; `repair-only` disables every non-repair feature. */
export const SUPERVISOR_MODES: readonly SupervisorMode[] = ['full', 'repair-only'];

/** Configuration for the tool-argument repair pipeline. */
export interface ArgRepairConfig {
  /** Master switch; when false, malformed arguments fail normally. */
  enabled: boolean;
  /**
   * Provider + model slug for the repair tier, e.g.
   * 'openrouter/deepseek/deepseek-v4-pro'. Unset falls back to the
   * auditor model (and its derived small-model fallback).
   */
  model?: string;
  /** Tool names in scope; '*' repairs every tool. Directive `repair` rules add more. */
  tools: string[];
  /** Per-session bound on model-tier repair attempts. */
  maxPerSession: number;
  /** Timeout for the model-tier side session, in milliseconds. */
  timeoutMs: number;
}

/**
 * Builtin tool IDs known to OpenCode 1.19.x (the registry's file-level keys
 * differ from the IDs tools advertise — `shell` is `bash`, `fetch` is
 * `webfetch`). MCP and plugin tools are not builtin; add them via
 * `argRepair.tools` or a directive `repair` rule.
 */
export const DEFAULT_REPAIR_TOOLS: readonly string[] = [
  'bash',
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'task',
  'webfetch',
  'todowrite',
  'websearch',
  'skill',
  'apply_patch',
  'question',
  'lsp',
  'plan_enter',
  'plan_exit',
];

/** Default `argRepair` configuration. */
export const DEFAULT_ARG_REPAIR: ArgRepairConfig = {
  enabled: true,
  tools: [...DEFAULT_REPAIR_TOOLS],
  maxPerSession: 8,
  timeoutMs: 15_000,
};

/** One schema violation found by {@link validateJsonSchemaSubset}. */
export interface SchemaIssue {
  /** '$'-rooted JSON path, e.g. '$.questions[0].header'. */
  path: string;
  /** Human-readable description, e.g. 'Expected array, got null'. */
  message: string;
}

/** How a repair was produced. */
export type RepairMethod = 'deterministic' | 'model';

/** Result of running the repair pipeline over one tool call. */
export interface RepairOutcome {
  /**
   * 'valid' — arguments already satisfy the schema (nothing to do);
   * 'repaired' — {@link args} satisfies the schema, apply it;
   * 'unrepairable' — the repair model declared recovery impossible;
   * 'error' — the pipeline failed; fail open and let the normal schema
   * error reach the model.
   */
  status: 'valid' | 'repaired' | 'unrepairable' | 'error';
  /** Repaired arguments; present only when status is 'repaired'. */
  args?: unknown;
  /** Which tier produced the repair; present only when status is 'repaired'. */
  method?: RepairMethod;
  /** Diagnostic for 'unrepairable' and 'error' outcomes. */
  reason?: string;
}

const MAX_SCHEMA_DEPTH = 32;
const MAX_ISSUES = 20;
const MAX_REPAIR_ROUNDS = 4;
const MAX_SCHEMA_CHARS = 8_000;
const MAX_ARGS_CHARS = 4_000;
const MAX_EVIDENCE_CHARS = 4_000;
const MAX_REF_HOPS = 8;

/** Narrow unknown to a plain (non-array, non-null) object. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type JsonSchema = Record<string, unknown>;

const asSchema = (value: unknown): JsonSchema | null =>
  isPlainObject(value) ? (value as JsonSchema) : null;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const tryParseJson = (text: string): { parsed: unknown } | null => {
  try {
    return { parsed: JSON.parse(text) };
  } catch {
    return null;
  }
};

const jsonEquals = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/**
 * Resolve a schema node, following `$ref: '#/...'` pointers against the
 * root schema (bounded, so cyclic references terminate). Returns null when
 * the chain is missing or too deep — callers treat an unresolvable schema
 * as a pass so an exotic schema never flags a healthy tool call.
 */
const resolveSchema = (schema: JsonSchema, root: JsonSchema): JsonSchema | null => {
  let current = schema;
  for (let hop = 0; hop < MAX_REF_HOPS; hop += 1) {
    const ref = current['$ref'];
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
      return current;
    }
    const segments = ref
      .slice(2)
      .split('/')
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target: unknown = root;
    for (const segment of segments) {
      if (isPlainObject(target)) {
        target = target[segment];
      } else if (Array.isArray(target)) {
        const index = Number(segment);
        target = Number.isInteger(index) ? target[index] : undefined;
      } else {
        target = undefined;
        break;
      }
    }
    const resolved = asSchema(target);
    if (resolved === null) {
      return null;
    }
    current = resolved;
  }
  return null;
};

const KNOWN_TYPES: readonly string[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
];

/** Type-keyword match; unknown type keywords pass (lenient). */
const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
};

const typeLabel = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  return typeof value;
};

const childPath = (parent: string, key: string): string => (parent === '' ? `$.${key}` : `${parent}.${key}`);

const displayPath = (path: string): string => (path === '' ? '$' : path);

/**
 * Lenient JSON-schema subset validator: type (string or array form), enum,
 * const, required, properties (present keys only), items (schema and tuple
 * forms), minItems/maxItems, minLength/maxLength, minimum/maximum,
 * anyOf/oneOf (pass when any branch passes), allOf, and `#/$defs`-style
 * $ref resolution. Unknown keywords and unknown type names pass — a false
 * 'invalid' verdict on a healthy call would trigger needless repairs.
 *
 * @param value Value to check.
 * @param schema JSON schema to check against.
 * @returns Issues found; empty means the value satisfies the subset.
 */
export const validateJsonSchemaSubset = (value: unknown, schema: unknown): SchemaIssue[] => {
  const root = asSchema(schema);
  if (root === null) {
    return [];
  }
  const issues: SchemaIssue[] = [];
  collectIssues(value, root, root, '', 0, issues);
  return issues;
};

const collectIssues = (
  value: unknown,
  schemaInput: unknown,
  root: JsonSchema,
  path: string,
  depth: number,
  issues: SchemaIssue[]
): void => {
  if (issues.length >= MAX_ISSUES || depth > MAX_SCHEMA_DEPTH) {
    return;
  }
  const rawSchema = asSchema(schemaInput);
  if (rawSchema === null) {
    return;
  }
  const schema = resolveSchema(rawSchema, root);
  if (schema === null) {
    return;
  }

  const typeKeyword = schema.type;
  if (typeof typeKeyword === 'string') {
    if (!matchesType(value, typeKeyword)) {
      issues.push({ path: displayPath(path), message: `Expected ${typeKeyword}, got ${typeLabel(value)}` });
      return;
    }
  } else if (Array.isArray(typeKeyword)) {
    const known = typeKeyword.filter(
      (entry): entry is string => typeof entry === 'string' && KNOWN_TYPES.includes(entry)
    );
    if (
      known.length > 0 &&
      known.length === typeKeyword.length &&
      !known.some((entry) => matchesType(value, entry))
    ) {
      issues.push({
        path: displayPath(path),
        message: `Expected ${typeKeyword.join(' | ')}, got ${typeLabel(value)}`,
      });
      return;
    }
  }

  const enumKeyword = schema.enum;
  if (Array.isArray(enumKeyword) && !enumKeyword.some((entry) => jsonEquals(value, entry))) {
    issues.push({ path: displayPath(path), message: `Value is not one of the enum values` });
  }
  const constKeyword = schema.const;
  if (constKeyword !== undefined && !jsonEquals(value, constKeyword)) {
    issues.push({ path: displayPath(path), message: `Value does not equal the const value` });
  }

  const branches =
    Array.isArray(schema.anyOf) && schema.anyOf.length > 0
      ? schema.anyOf
      : Array.isArray(schema.oneOf) && schema.oneOf.length > 0
        ? schema.oneOf
        : null;
  if (branches !== null) {
    const passes = branches.some((branch) => isClean(value, branch, root, depth));
    if (!passes) {
      const kind = Array.isArray(schema.anyOf) ? 'anyOf' : 'oneOf';
      issues.push({ path: displayPath(path), message: `Value matches none of the ${kind} branches` });
    }
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      collectIssues(value, branch, root, path, depth + 1, issues);
      if (issues.length >= MAX_ISSUES) {
        return;
      }
    }
  }

  if (isPlainObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) {
          issues.push({ path: displayPath(childPath(path, key)), message: `Missing required property '${key}'` });
          if (issues.length >= MAX_ISSUES) {
            return;
          }
        }
      }
    }
    const properties = asSchema(schema.properties);
    if (properties !== null) {
      for (const [key, childValue] of Object.entries(value)) {
        if (key in properties) {
          collectIssues(childValue, properties[key], root, childPath(path, key), depth + 1, issues);
          if (issues.length >= MAX_ISSUES) {
            return;
          }
        }
      }
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema.minItems;
    if (typeof minItems === 'number' && Number.isFinite(minItems) && value.length < minItems) {
      issues.push({
        path: displayPath(path),
        message: `Expected at least ${minItems} item(s), got ${value.length}`,
      });
    }
    const maxItems = schema.maxItems;
    if (typeof maxItems === 'number' && Number.isFinite(maxItems) && value.length > maxItems) {
      issues.push({
        path: displayPath(path),
        message: `Expected at most ${maxItems} item(s), got ${value.length}`,
      });
    }
    const items = schema.items;
    if (Array.isArray(items)) {
      for (let i = 0; i < value.length && i < items.length; i += 1) {
        collectIssues(value[i], items[i], root, `${displayPath(path)}[${i}]`, depth + 1, issues);
        if (issues.length >= MAX_ISSUES) {
          return;
        }
      }
    } else if (items !== undefined) {
      for (let i = 0; i < value.length; i += 1) {
        collectIssues(value[i], items, root, `${displayPath(path)}[${i}]`, depth + 1, issues);
        if (issues.length >= MAX_ISSUES) {
          return;
        }
      }
    }
  }

  if (typeof value === 'string') {
    const minLength = schema.minLength;
    if (typeof minLength === 'number' && Number.isFinite(minLength) && value.length < minLength) {
      issues.push({
        path: displayPath(path),
        message: `Expected length of at least ${minLength}, got ${value.length}`,
      });
    }
    const maxLength = schema.maxLength;
    if (typeof maxLength === 'number' && Number.isFinite(maxLength) && value.length > maxLength) {
      issues.push({
        path: displayPath(path),
        message: `Expected length of at most ${maxLength}, got ${value.length}`,
      });
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const minimum = schema.minimum;
    if (typeof minimum === 'number' && Number.isFinite(minimum) && value < minimum) {
      issues.push({ path: displayPath(path), message: `Expected a value of at least ${minimum}` });
    }
    const maximum = schema.maximum;
    if (typeof maximum === 'number' && Number.isFinite(maximum) && value > maximum) {
      issues.push({ path: displayPath(path), message: `Expected a value of at most ${maximum}` });
    }
  }
};

const isClean = (value: unknown, schemaInput: unknown, root: JsonSchema, depth: number): boolean => {
  const nested: SchemaIssue[] = [];
  collectIssues(value, schemaInput, root, '', depth + 1, nested);
  return nested.length === 0;
};

/**
 * Extract the first balanced JSON array or object embedded in a string,
 * respecting quoted-string escapes, with a fallback slice between the first
 * opening bracket and the last closing bracket (handles trailing garbage).
 * Returns null when nothing parseable is embedded.
 */
const extractEmbeddedJson = (text: string): { parsed: unknown } | null => {
  const start = Math.min(
    ...(['[', '{'] as const).map((open) => {
      const at = text.indexOf(open);
      return at === -1 ? text.length : at;
    })
  );
  if (start >= text.length) {
    return null;
  }
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === open) {
      depth += 1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        const attempt = tryParseJson(text.slice(start, i + 1));
        if (attempt !== null) {
          return attempt;
        }
        break;
      }
    }
  }
  const lastClose = text.lastIndexOf(close);
  if (lastClose > start) {
    const attempt = tryParseJson(text.slice(start, lastClose + 1));
    if (attempt !== null) {
      return attempt;
    }
  }
  return null;
};

const propertySchema = (root: JsonSchema, key: string): JsonSchema | null => {
  const properties = asSchema(root.properties);
  if (properties === null || !(key in properties)) {
    return null;
  }
  const schema = asSchema(properties[key]);
  if (schema === null) {
    return null;
  }
  return resolveSchema(schema, root);
};

const expectsArray = (schema: JsonSchema): boolean => {
  const type = schema.type;
  if (typeof type === 'string') {
    return type === 'array';
  }
  if (Array.isArray(type)) {
    return type.includes('array');
  }
  return schema.items !== undefined;
};

const itemRequiredFields = (schema: JsonSchema, root: JsonSchema): string[] => {
  const items = schema.items;
  const branches: unknown[] = Array.isArray(items) ? items : items === undefined ? [] : [items];
  const required: string[] = [];
  for (const branch of branches) {
    const branchSchema = asSchema(branch);
    if (branchSchema === null) {
      continue;
    }
    const resolved = resolveSchema(branchSchema, root) ?? branchSchema;
    if (Array.isArray(resolved.required)) {
      for (const key of resolved.required) {
        if (typeof key === 'string' && !required.includes(key)) {
          required.push(key);
        }
      }
    }
  }
  return required;
};

const parseRootString = (args: unknown): Record<string, unknown> | null => {
  if (typeof args !== 'string') {
    return null;
  }
  const attempt = tryParseJson(args.trim());
  if (attempt === null || !isPlainObject(attempt.parsed)) {
    return null;
  }
  return attempt.parsed;
};

const parseStringifiedValues = (args: unknown): Record<string, unknown> | null => {
  if (!isPlainObject(args)) {
    return null;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        const attempt = tryParseJson(trimmed);
        if (attempt !== null) {
          next[key] = attempt.parsed;
          changed = true;
          continue;
        }
      }
    }
    next[key] = value;
  }
  return changed ? next : null;
};

const extractStringifiedFragments = (args: unknown): Record<string, unknown> | null => {
  if (!isPlainObject(args)) {
    return null;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      const attempt = extractEmbeddedJson(value);
      if (attempt !== null) {
        next[key] = attempt.parsed;
        changed = true;
        continue;
      }
    }
    next[key] = value;
  }
  return changed ? next : null;
};

const wrapObjectValues = (args: unknown, root: JsonSchema): Record<string, unknown> | null => {
  if (!isPlainObject(args)) {
    return null;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const schema = propertySchema(root, key);
    if (schema !== null && expectsArray(schema) && isPlainObject(value)) {
      next[key] = [value];
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : null;
};

const mergeFragmentValue = (
  value: unknown,
  schema: JsonSchema | null,
  root: JsonSchema
): unknown[] | null => {
  if (schema === null || !expectsArray(schema) || !Array.isArray(value) || value.length < 2) {
    return null;
  }
  const required = itemRequiredFields(schema, root);
  if (required.length === 0) {
    return null;
  }
  const missingRequired = (entry: unknown): boolean =>
    isPlainObject(entry) && required.some((key) => !(key in entry));
  let run = 0;
  while (run < value.length && missingRequired(value[run])) {
    run += 1;
  }
  if (run < 2) {
    return null;
  }
  const merged: Record<string, unknown> = {};
  for (let i = 0; i < run; i += 1) {
    Object.assign(merged, value[i]);
  }
  return [merged, ...value.slice(run)];
};

const mergeFragmentArrays = (args: unknown, root: JsonSchema): Record<string, unknown> | null => {
  if (!isPlainObject(args)) {
    return null;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const merged = mergeFragmentValue(value, propertySchema(root, key), root);
    if (merged !== null) {
      next[key] = merged;
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : null;
};

const dropNullProperties = (args: unknown, root: JsonSchema): Record<string, unknown> | null => {
  if (!isPlainObject(args)) {
    return null;
  }
  const rootRequired = Array.isArray(root.required)
    ? root.required.filter((key): key is string => typeof key === 'string')
    : [];
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null && !rootRequired.includes(key)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : null;
};

/**
 * Deterministic structural repair: applies at most {@link MAX_REPAIR_ROUNDS}
 * rounds of the first applicable transform, in priority order —
 * (1) parse a stringified whole-object root, (2) parse JSON-stringified
 * string values, (3) extract balanced JSON embedded in string values,
 * (4) wrap a bare object where the schema wants an array, (5) merge a
 * prefix run of incomplete array fragments into one element, (6) drop
 * null values for keys the root schema does not require. Every candidate
 * must re-validate clean before it is returned.
 *
 * @param args The emitted (invalid) arguments.
 * @param schema The tool's JSON schema.
 * @returns Repaired arguments, or null when no deterministic repair applies.
 */
export const deterministicRepair = (args: unknown, schema: unknown): { args: unknown } | null => {
  const root = asSchema(schema);
  if (root === null) {
    return null;
  }
  if (validateJsonSchemaSubset(args, root).length === 0) {
    return null;
  }
  let current: unknown = args;
  for (let round = 0; round < MAX_REPAIR_ROUNDS; round += 1) {
    const transforms: Array<() => Record<string, unknown> | null> = [
      () => parseRootString(current),
      () => parseStringifiedValues(current),
      () => extractStringifiedFragments(current),
      () => wrapObjectValues(current, root),
      () => mergeFragmentArrays(current, root),
      () => dropNullProperties(current, root),
    ];
    const candidate = transforms.map((transform) => transform()).find((next) => next !== null);
    if (candidate === undefined) {
      return null;
    }
    current = candidate;
    if (validateJsonSchemaSubset(current, root).length === 0) {
      return { args: current };
    }
  }
  return null;
};

const REPAIR_INSTRUCTIONS = `You repair malformed tool-call arguments emitted by a coding-agent model before the tool executes.

Rules:
- Recover argument values verbatim from the emitted arguments and the assistant reasoning evidence below. Fix only structure — types, nesting, keys, stringification — so the arguments satisfy the JSON schema.
- NEVER invent file contents, code, command bodies, or other substantive text that does not appear in the emitted arguments or evidence. If a required value cannot be recovered, declare the arguments unrepairable.
- Respond with ONLY a JSON object — no prose, no code fences — in one of these shapes:
  {"args": <repaired arguments object satisfying the schema>}
  {"unrepairable": true, "reason": "<what could not be recovered>"}`;

/** Inputs for {@link buildRepairPrompt}. */
export interface RepairPromptInput {
  /** Tool name the malformed arguments were emitted for. */
  tool: string;
  /** The tool's JSON schema. */
  schema: unknown;
  /** The emitted (invalid) arguments. */
  args: unknown;
  /** Validation issues for the emitted arguments. */
  issues: SchemaIssue[];
  /** Assistant reasoning/text preceding the call; may be empty. */
  evidence: string;
}

const truncateHead = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`;

const truncateTail = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `…(truncated)\n${text.slice(text.length - maxChars)}`;

const stringifyBounded = (value: unknown, maxChars: number): string => {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    return '(not serializable)';
  }
  return truncateHead(text, maxChars);
};

/**
 * Build the model-tier repair prompt: instructions (verbatim recovery,
 * no invention, strict JSON response contract), the tool schema, the
 * emitted arguments, the validation issues, and the tail-truncated
 * reasoning evidence.
 *
 * @param input Prompt inputs (tool, schema, args, issues, evidence).
 * @returns The complete prompt text.
 */
export const buildRepairPrompt = (input: RepairPromptInput): string => {
  const issueLines =
    input.issues.length > 0
      ? input.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')
      : '- (none)';
  const evidence = input.evidence.trim();
  const sections = [
    REPAIR_INSTRUCTIONS,
    `Tool:\n${input.tool}`,
    `JSON schema (tool parameters):\n${stringifyBounded(input.schema, MAX_SCHEMA_CHARS)}`,
    `Emitted arguments (invalid):\n${stringifyBounded(input.args, MAX_ARGS_CHARS)}`,
    `Validation issues:\n${issueLines}`,
    `Assistant reasoning evidence (may be empty):\n${
      evidence === '' ? '(none)' : truncateTail(evidence, MAX_EVIDENCE_CHARS)
    }`,
  ];
  return sections.join('\n\n');
};

/** Lenient parse result of a repair-model response. */
export interface RepairResponse {
  /** Present when the model returned repaired arguments. */
  args?: unknown;
  /** True when the model declared recovery impossible. */
  unrepairable?: boolean;
  /** Reason accompanying an unrepairable verdict. */
  reason?: string;
}

/**
 * Leniently parse a repair-model response: candidates are the slice from
 * the first '{' to the last '}' and then every flat '{...}' block (same
 * tolerance the peer-audit verdict parser applies to chatty models).
 *
 * @param response Raw model response text.
 * @returns Parsed verdict, or null when nothing parseable is present.
 */
export const parseRepairResponse = (response: string): RepairResponse | null => {
  const first = response.indexOf('{');
  const last = response.lastIndexOf('}');
  const candidates: string[] = [];
  if (first !== -1 && last > first) {
    candidates.push(response.slice(first, last + 1));
  }
  for (const match of response.matchAll(/\{[^{}]*\}/g)) {
    candidates.push(match[0]);
  }
  for (const candidate of candidates) {
    const attempt = tryParseJson(candidate);
    if (attempt === null || !isPlainObject(attempt.parsed)) {
      continue;
    }
    const parsed = attempt.parsed;
    if ('args' in parsed) {
      return { args: parsed.args };
    }
    if (parsed.unrepairable === true) {
      const reason = parsed.reason;
      return { unrepairable: true, reason: typeof reason === 'string' ? reason : '' };
    }
  }
  return null;
};

/** Model-invocation boundary for the repair tier (text in, text out). */
export type RepairInvoker = (prompt: string) => Promise<string>;

/** Context for one repair attempt. */
export interface RepairContext {
  /** Tool name the malformed arguments were emitted for. */
  tool: string;
  /** Optional lazy evidence getter (assistant reasoning preceding the call). */
  getEvidence?: () => Promise<string>;
};

/**
 * Run the repair pipeline over one tool call: validate, deterministic
 * repair, then (when an invoker is supplied) the model tier with
 * re-validation of the model's candidate. Never throws — every model or
 * parse failure becomes an 'error' outcome the hook layer fails open on.
 *
 * @param args The emitted arguments (mutated only by the caller).
 * @param schema The tool's JSON schema.
 * @param invokeModel Model-tier invoker, or null to skip the model tier.
 * @param context Tool name and optional evidence getter.
 * @returns The repair outcome.
 */
export const repairToolArgs = async (
  args: unknown,
  schema: unknown,
  invokeModel: RepairInvoker | null,
  context: RepairContext
): Promise<RepairOutcome> => {
  const root = asSchema(schema);
  if (root === null) {
    return { status: 'valid' };
  }
  const issues = validateJsonSchemaSubset(args, root);
  if (issues.length === 0) {
    return { status: 'valid' };
  }
  const deterministic = deterministicRepair(args, root);
  if (deterministic !== null) {
    return { status: 'repaired', args: deterministic.args, method: 'deterministic' };
  }
  if (invokeModel === null) {
    return { status: 'error', reason: 'no repair model configured' };
  }
  let evidence = '';
  if (context.getEvidence !== undefined) {
    try {
      evidence = await context.getEvidence();
    } catch {
      evidence = '';
    }
  }
  const prompt = buildRepairPrompt({ tool: context.tool, schema: root, args, issues, evidence });
  let response: string;
  try {
    response = await invokeModel(prompt);
  } catch (error) {
    return { status: 'error', reason: `repair model call failed: ${errorText(error)}` };
  }
  const parsed = parseRepairResponse(response);
  if (parsed === null) {
    return { status: 'error', reason: 'repair response contained no parseable JSON' };
  }
  if (parsed.unrepairable === true) {
    return {
      status: 'unrepairable',
      reason:
        parsed.reason !== undefined && parsed.reason !== ''
          ? parsed.reason
          : 'repair model declared the arguments unrepairable',
    };
  }
  const recheck = validateJsonSchemaSubset(parsed.args, root);
  if (recheck.length > 0) {
    return {
      status: 'error',
      reason: `repaired arguments still invalid: ${recheck[0]?.path}: ${recheck[0]?.message}`,
    };
  }
  return { status: 'repaired', args: parsed.args, method: 'model' };
};

/**
 * Apply repaired arguments to the live args object in place. OpenCode 1.19
 * hands the hook the same object reference the tool will decode, so
 * mutation — not reassignment — is the only way a repair takes effect.
 *
 * @param target The hook's live args object.
 * @param source Repaired arguments to replace target's contents with.
 * @returns True when the merge was applied; false when either side is not
 *   a plain object (the caller logs and fails open).
 */
export const mergeArgsInPlace = (target: Record<string, unknown>, source: unknown): boolean => {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return false;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
  return true;
};
