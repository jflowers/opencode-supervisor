/**
 * Tool-arg repair (arg-repair feature): JSON-schema-subset validation,
 * deterministic repair transforms, the repair-model prompt/response contract,
 * config-file validation for `mode`/`argRepair`, and the tool.execute.before
 * repair pass — including repair-only mode. Unit tests drive src/arg-repair.ts
 * directly with the real GLM 5.3 failure shapes observed on enmaas (null
 * arrays, stringified arrays, split fragments); hook-layer tests drive the
 * plugin with a recording mock client, using the same harness shape as
 * test/gates.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Hooks, PluginInput, PluginOptions } from '@opencode-ai/plugin';

import plugin from '../index.ts';
import { silentClientSurface } from './mocks.ts';
import {
  buildRepairPrompt,
  deterministicRepair,
  mergeArgsInPlace,
  parseRepairResponse,
  repairToolArgs,
  validateJsonSchemaSubset,
  type RepairInvoker,
} from '../src/arg-repair.ts';
import { validateSupervisorConfig } from '../src/config-file.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────

/** The question tool's parameter schema, in the $defs/$ref shape the tool list advertises. */
const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { $ref: '#/$defs/QuestionPrompt' } },
  },
  required: ['questions'],
  $defs: {
    QuestionPrompt: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        header: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, description: { type: 'string' } },
            required: ['label', 'description'],
          },
        },
        multiple: { type: 'boolean' },
      },
      required: ['question', 'header', 'options'],
    },
  },
};

/** The PR #890 review question GLM 5.3 kept failing to emit correctly. */
const VALID_QUESTIONS = [
  {
    question: 'Post GitHub review?',
    header: 'Review action',
    options: [
      { label: 'Post', description: 'Submit the review' },
      { label: 'Hold', description: 'Keep drafting' },
    ],
    multiple: false,
  },
];

const BASH_SCHEMA = {
  type: 'object',
  properties: { command: { type: 'string' }, timeout: { type: 'number' } },
  required: ['command'],
};

const DEWEY_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

/** What client.tool.list returns for the session's provider/model. */
const TOOL_LIST = [
  { id: 'question', description: 'Ask the user questions', parameters: QUESTION_SCHEMA },
  { id: 'bash', description: 'Run a shell command', parameters: BASH_SCHEMA },
  { id: 'dewey_search', description: 'Search notes', parameters: DEWEY_SCHEMA },
];

/** The reasoning evidence recovered from the assistant message that emitted the call. */
const EVIDENCE_REASONING =
  'The review summary is done. I should ask whether to post it, with Post and Hold options.';

/** Session messages as client.session.messages returns them: the in-progress assistant message. */
const EVIDENCE_MESSAGES = [
  {
    info: {
      id: 'msg_a',
      sessionID: 'sess_1',
      role: 'assistant',
      providerID: 'enmaas',
      modelID: 'glm-5-3',
      time: { created: 1 },
    },
    parts: [
      { type: 'reasoning', text: EVIDENCE_REASONING },
      { type: 'tool', callID: 'call-1', tool: 'question', state: { status: 'pending' } },
    ],
  },
];

/** The repair model's canonical success reply. */
const REPAIRED_RESPONSE = JSON.stringify({ args: { questions: VALID_QUESTIONS } });

// ── Mock client ───────────────────────────────────────────────────────────

interface RepairMockOptions {
  directory?: string;
  promptResponse?: string;
  promptRejects?: boolean;
  toolListRejects?: boolean;
}

/**
 * A plugin input whose side-session prompt replies with `promptResponse`
 * (or rejects), whose tool list serves TOOL_LIST (or rejects), and whose
 * session messages carry the evidence fixture — recording every repair-
 * relevant client call.
 */
function repairPluginInput(options: RepairMockOptions = {}): {
  input: PluginInput;
  promptTexts: string[];
  toolListQueries: Array<Record<string, unknown>>;
} {
  const promptTexts: string[] = [];
  const toolListQueries: Array<Record<string, unknown>> = [];
  const input = {
    client: {
      session: {
        create: async () => ({ data: { id: 'repair-side-session' } }),
        prompt: async (request: unknown) => {
          const body = (request as { body?: { parts?: Array<{ text?: unknown }> } }).body;
          const text = body?.parts?.[0]?.text;
          promptTexts.push(typeof text === 'string' ? text : '');
          if (options.promptRejects === true) {
            throw new Error('repair model unavailable');
          }
          return { data: { info: {}, parts: [{ type: 'text', text: options.promptResponse ?? REPAIRED_RESPONSE }] } };
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
        messages: async () => ({ data: EVIDENCE_MESSAGES }),
      },
      tool: {
        list: async (request: unknown) => {
          toolListQueries.push((request as { query?: Record<string, unknown> }).query ?? {});
          if (options.toolListRejects === true) {
            throw new Error('tool list unavailable');
          }
          return { data: TOOL_LIST };
        },
      },
      ...silentClientSurface,
    },
    directory: options.directory ?? '/tmp/supervisor-repair-test',
  };
  return { input: input as unknown as PluginInput, promptTexts, toolListQueries };
}

/** Plugin options carrying a raw config object, the tuple-registration shape. */
function serverOptions(config: Record<string, unknown>): PluginOptions {
  return { config } as unknown as PluginOptions;
}

/** Standard repair-only registration: model tier armed with the mock slug. */
function repairOnlyOptions(overrides: Record<string, unknown> = {}): PluginOptions {
  return serverOptions({ mode: 'repair-only', argRepair: { model: 'mock/repair-model', ...overrides } });
}

// ── Dispatch helpers ──────────────────────────────────────────────────────

/** Hook map with chat.message loosened for raw payloads (audit.test.ts precedent). */
type DispatchHooks = Hooks & {
  'chat.message'?(input: unknown, output: unknown): Promise<void>;
};

/** Dispatches one tool.execute.before through the hook with raw args. */
function dispatchToolBefore(
  hooks: Hooks,
  sessionID: string,
  tool: string,
  args: unknown,
  callID = 'call-1'
): Promise<void> {
  return hooks['tool.execute.before']!({ tool, sessionID, callID }, { args });
}

/** Dispatches one user chat.message carrying the session's model identity. */
function dispatchChatMessage(
  hooks: Hooks,
  sessionID: string,
  model?: { providerID: string; modelID: string }
): Promise<void> {
  const dispatch = hooks as DispatchHooks;
  return dispatch['chat.message']!(
    { sessionID, model },
    {
      message: { id: 'm1', role: 'user' },
      parts: [{ type: 'text', text: 'Ship the supervisor.' }],
    }
  );
}

// ── Env isolation ─────────────────────────────────────────────────────────

/** Every OPENCODE_SUPERVISOR_* knob, for env-cleaning around hook-layer tests. */
const REPAIR_ENV_NAMES = [
  'OPENCODE_SUPERVISOR_MODEL',
  'OPENCODE_SUPERVISOR_VARIANT',
  'OPENCODE_SUPERVISOR_MAX_REGENERATIONS',
  'OPENCODE_SUPERVISOR_STRIP_MODE',
  'OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING',
  'OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS',
  'OPENCODE_SUPERVISOR_MEMO_MAX_SOLVED_ITEMS',
  'OPENCODE_SUPERVISOR_MEMO_MAX_CRITIQUES',
  'OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS',
  'OPENCODE_SUPERVISOR_MEMO_MAX_REPORTS',
  'OPENCODE_SUPERVISOR_MAX_ON_DEMAND_AUDITS',
  'OPENCODE_SUPERVISOR_MAX_TIMEOUT_FAIL_OPENS',
  'OPENCODE_SUPERVISOR_MODE',
  'OPENCODE_SUPERVISOR_REPAIR_MODEL',
];

/** Saves/deletes the supervisor env knobs and isolates XDG_CONFIG_HOME around `run`. */
async function withCleanRepairEnv(run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of REPAIR_ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  const savedXdgHome = process.env.XDG_CONFIG_HOME;
  const isolatedXdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  process.env.XDG_CONFIG_HOME = isolatedXdgRoot;
  try {
    await run();
  } finally {
    for (const name of REPAIR_ENV_NAMES) {
      const value = saved[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    if (savedXdgHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgHome;
    }
    fs.rmSync(isolatedXdgRoot, { recursive: true, force: true });
  }
}

// ── Directive helpers ─────────────────────────────────────────────────────

/** A directive markdown file: advisory text plus a fenced supervisor rules block. */
function directiveFile(text: string, rules: object | null): string {
  return `${text}\n\n\`\`\`supervisor\n${JSON.stringify(rules)}\n\`\`\`\n`;
}

/** Creates a temp project dir with directive files under .opencode/supervisor/directives. */
function makeDirectiveDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-repair-'));
  const directivesDir = path.join(dir, '.opencode', 'supervisor', 'directives');
  fs.mkdirSync(directivesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directivesDir, name), content);
  }
  return dir;
}

// ── Pure module: validateJsonSchemaSubset ─────────────────────────────────

test('validateJsonSchemaSubset accepts valid question args', () => {
  assert.deepEqual(validateJsonSchemaSubset({ questions: VALID_QUESTIONS }, QUESTION_SCHEMA), []);
});

test('validateJsonSchemaSubset flags a null required array', () => {
  const issues = validateJsonSchemaSubset({ questions: null }, QUESTION_SCHEMA);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, '$.questions');
  assert.match(issues[0].message, /Expected array, got null/);
});

test('validateJsonSchemaSubset flags a stringified array', () => {
  const issues = validateJsonSchemaSubset({ questions: 'not an array' }, QUESTION_SCHEMA);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /Expected array, got string/);
});

test('validateJsonSchemaSubset flags a missing required property inside array items', () => {
  const issues = validateJsonSchemaSubset(
    { questions: [{ question: 'q', options: VALID_QUESTIONS[0].options }] },
    QUESTION_SCHEMA
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, '$.questions[0].header');
  assert.match(issues[0].message, /Missing required property 'header'/);
});

test('validateJsonSchemaSubset ignores unknown properties', () => {
  assert.deepEqual(validateJsonSchemaSubset({ questions: VALID_QUESTIONS, extra: 1 }, QUESTION_SCHEMA), []);
});

test('validateJsonSchemaSubset accepts any matching anyOf branch', () => {
  const schema = {
    type: 'object',
    properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    required: ['x'],
  };
  assert.deepEqual(validateJsonSchemaSubset({ x: 5 }, schema), []);
  assert.equal(validateJsonSchemaSubset({ x: true }, schema).length, 1);
});

test('validateJsonSchemaSubset enforces enum values', () => {
  const schema = {
    type: 'object',
    properties: { mode: { enum: ['full', 'repair-only'] } },
    required: ['mode'],
  };
  assert.deepEqual(validateJsonSchemaSubset({ mode: 'full' }, schema), []);
  assert.equal(validateJsonSchemaSubset({ mode: 'sometimes' }, schema).length, 1);
});

// ── Pure module: deterministicRepair (real GLM 5.3 failure shapes) ───────

test('deterministicRepair returns null for valid args', () => {
  assert.equal(deterministicRepair({ questions: VALID_QUESTIONS }, QUESTION_SCHEMA), null);
});

test('deterministicRepair cannot fix a required null array', () => {
  assert.equal(deterministicRepair({ questions: null }, QUESTION_SCHEMA), null);
});

test('deterministicRepair parses a stringified questions array', () => {
  const outcome = deterministicRepair({ questions: JSON.stringify(VALID_QUESTIONS) }, QUESTION_SCHEMA);
  assert.deepEqual(outcome, { args: { questions: VALID_QUESTIONS } });
});

test('deterministicRepair merges split array fragments', () => {
  const outcome = deterministicRepair(
    {
      questions: [
        { question: 'Post GitHub review?', header: 'Review action' },
        { options: VALID_QUESTIONS[0].options },
      ],
    },
    QUESTION_SCHEMA
  );
  assert.deepEqual(outcome, {
    args: {
      questions: [{ question: 'Post GitHub review?', header: 'Review action', options: VALID_QUESTIONS[0].options }],
    },
  });
});

test('deterministicRepair parses a root JSON string', () => {
  const outcome = deterministicRepair(JSON.stringify({ command: 'ls -la' }), BASH_SCHEMA);
  assert.deepEqual(outcome, { args: { command: 'ls -la' } });
});

test('deterministicRepair drops null optional properties', () => {
  const outcome = deterministicRepair({ command: 'ls', timeout: null }, BASH_SCHEMA);
  assert.deepEqual(outcome, { args: { command: 'ls' } });
});

test('deterministicRepair extracts embedded JSON from a garbled string', () => {
  const outcome = deterministicRepair(
    { questions: `garbage prefix ${JSON.stringify(VALID_QUESTIONS)} trailing` },
    QUESTION_SCHEMA
  );
  assert.deepEqual(outcome, { args: { questions: VALID_QUESTIONS } });
});

test('deterministicRepair gives up on truncated JSON', () => {
  const outcome = deterministicRepair(
    { questions: JSON.stringify(VALID_QUESTIONS).slice(0, 20) },
    QUESTION_SCHEMA
  );
  assert.equal(outcome, null);
});

// ── Pure module: parseRepairResponse ──────────────────────────────────────

test('parseRepairResponse reads a clean args object', () => {
  assert.deepEqual(parseRepairResponse('{"args": {"a": 1}}'), { args: { a: 1 } });
});

test('parseRepairResponse reads through code fences', () => {
  assert.deepEqual(parseRepairResponse('```json\n{"args": {"a": 1}}\n```'), { args: { a: 1 } });
});

test('parseRepairResponse reads an unrepairable verdict', () => {
  assert.deepEqual(
    parseRepairResponse('{"unrepairable": true, "reason": "cannot recover"}'),
    { unrepairable: true, reason: 'cannot recover' }
  );
});

test('parseRepairResponse defaults the unrepairable reason to empty', () => {
  assert.deepEqual(parseRepairResponse('{"unrepairable": true}'), { unrepairable: true, reason: '' });
});

test('parseRepairResponse returns null for non-JSON text', () => {
  assert.equal(parseRepairResponse('no json here'), null);
});

// ── Pure module: buildRepairPrompt ────────────────────────────────────────

test('buildRepairPrompt embeds the tool, schema, issues, and evidence', () => {
  const prompt = buildRepairPrompt({
    tool: 'question',
    schema: QUESTION_SCHEMA,
    args: { questions: null },
    issues: [{ path: '$.questions', message: 'Expected array, got null' }],
    evidence: EVIDENCE_REASONING,
  });
  assert.ok(prompt.includes('Tool:\nquestion'));
  assert.ok(prompt.includes('"type": "object"'));
  assert.ok(prompt.includes('- $.questions: Expected array, got null'));
  assert.ok(prompt.includes(EVIDENCE_REASONING));
  assert.ok(prompt.includes('NEVER invent'));
});

test('buildRepairPrompt notes absent evidence', () => {
  const prompt = buildRepairPrompt({ tool: 'bash', schema: BASH_SCHEMA, args: {}, issues: [], evidence: '' });
  assert.ok(prompt.includes('(none)'));
});

// ── Pure module: repairToolArgs ───────────────────────────────────────────

/** Evidence-bearing context matching the hook layer's getEvidence wiring. */
const REPAIR_CONTEXT = { tool: 'question', getEvidence: async () => EVIDENCE_REASONING };

test('repairToolArgs reports valid args without a model call', async () => {
  let calls = 0;
  const invoker: RepairInvoker = async () => {
    calls += 1;
    return '';
  };
  const outcome = await repairToolArgs({ questions: VALID_QUESTIONS }, QUESTION_SCHEMA, invoker, REPAIR_CONTEXT);
  assert.deepEqual(outcome, { status: 'valid' });
  assert.equal(calls, 0);
});

test('repairToolArgs repairs deterministically without a model call', async () => {
  let calls = 0;
  const invoker: RepairInvoker = async () => {
    calls += 1;
    return '';
  };
  const outcome = await repairToolArgs(
    { questions: JSON.stringify(VALID_QUESTIONS) },
    QUESTION_SCHEMA,
    invoker,
    REPAIR_CONTEXT
  );
  assert.equal(outcome.status, 'repaired');
  assert.equal(outcome.method, 'deterministic');
  assert.deepEqual(outcome.args, { questions: VALID_QUESTIONS });
  assert.equal(calls, 0);
});

test('repairToolArgs falls back to the model tier for required nulls', async () => {
  const outcome = await repairToolArgs(
    { questions: null },
    QUESTION_SCHEMA,
    async () => REPAIRED_RESPONSE,
    REPAIR_CONTEXT
  );
  assert.equal(outcome.status, 'repaired');
  assert.equal(outcome.method, 'model');
  assert.deepEqual(outcome.args, { questions: VALID_QUESTIONS });
});

test('repairToolArgs surfaces an unrepairable verdict', async () => {
  const outcome = await repairToolArgs(
    { questions: null },
    QUESTION_SCHEMA,
    async () => '{"unrepairable": true, "reason": "no recoverable array"}',
    REPAIR_CONTEXT
  );
  assert.deepEqual(outcome, { status: 'unrepairable', reason: 'no recoverable array' });
});

test('repairToolArgs fails open when the model call rejects', async () => {
  const outcome = await repairToolArgs(
    { questions: null },
    QUESTION_SCHEMA,
    async () => {
      throw new Error('boom');
    },
    REPAIR_CONTEXT
  );
  assert.equal(outcome.status, 'error');
  assert.match(outcome.reason ?? '', /repair model call failed/);
});

test('repairToolArgs fails open on a non-JSON model response', async () => {
  const outcome = await repairToolArgs({ questions: null }, QUESTION_SCHEMA, async () => 'not json', REPAIR_CONTEXT);
  assert.equal(outcome.status, 'error');
  assert.match(outcome.reason ?? '', /no parseable JSON/);
});

test('repairToolArgs rejects model output that is still invalid', async () => {
  const outcome = await repairToolArgs(
    { questions: null },
    QUESTION_SCHEMA,
    async () => '{"args": {"questions": null}}',
    REPAIR_CONTEXT
  );
  assert.equal(outcome.status, 'error');
  assert.match(outcome.reason ?? '', /still invalid/);
});

test('repairToolArgs reports no repair model when the invoker is null', async () => {
  const outcome = await repairToolArgs({ questions: null }, QUESTION_SCHEMA, null, REPAIR_CONTEXT);
  assert.equal(outcome.status, 'error');
  assert.match(outcome.reason ?? '', /no repair model configured/);
});

// ── Pure module: mergeArgsInPlace ─────────────────────────────────────────

test('mergeArgsInPlace replaces keys on the same object reference', () => {
  const target: Record<string, unknown> = { a: 1, b: 2 };
  const reference = target;
  assert.equal(mergeArgsInPlace(target, { b: 3, c: 4 }), true);
  assert.ok(target === reference);
  assert.deepEqual(target, { b: 3, c: 4 });
});

test('mergeArgsInPlace refuses non-object sources', () => {
  const target: Record<string, unknown> = { a: 1 };
  assert.equal(mergeArgsInPlace(target, 'nope'), false);
  assert.deepEqual(target, { a: 1 });
});

// ── Config-file validation: mode + argRepair ──────────────────────────────

test('validateSupervisorConfig accepts a known mode', () => {
  const { config, error } = validateSupervisorConfig({ mode: 'repair-only' });
  assert.equal(error, null);
  assert.equal(config.mode, 'repair-only');
});

test('validateSupervisorConfig rejects an unknown mode', () => {
  const { config, error } = validateSupervisorConfig({ mode: 'sometimes' });
  assert.match(error ?? '', /"mode" must be one of/);
  assert.equal(config.mode, undefined);
});

test('validateSupervisorConfig accepts a full argRepair block', () => {
  const { config, error } = validateSupervisorConfig({
    argRepair: {
      enabled: false,
      model: 'openrouter/deepseek/deepseek-v4-pro',
      tools: ['question', '*'],
      maxPerSession: 3,
      timeoutMs: 20000,
    },
  });
  assert.equal(error, null);
  assert.equal(config.argRepair?.enabled, false);
  assert.equal(config.argRepair?.model, 'openrouter/deepseek/deepseek-v4-pro');
  assert.deepEqual(config.argRepair?.tools, ['question', '*']);
  assert.equal(config.argRepair?.maxPerSession, 3);
  assert.equal(config.argRepair?.timeoutMs, 20000);
});

test('validateSupervisorConfig rejects a malformed argRepair block', () => {
  assert.match(validateSupervisorConfig({ argRepair: 'nope' }).error ?? '', /"argRepair" must be an object/);
  assert.match(
    validateSupervisorConfig({ argRepair: { model: 'noslash' } }).error ?? '',
    /"argRepair\.model" must be a provider\/model slug/
  );
  assert.match(
    validateSupervisorConfig({ argRepair: { tools: 'bash' } }).error ?? '',
    /"argRepair\.tools" must be an array/
  );
  assert.match(
    validateSupervisorConfig({ argRepair: { tools: [''] } }).error ?? '',
    /"argRepair\.tools" must be an array/
  );
  assert.match(
    validateSupervisorConfig({ argRepair: { maxPerSession: -1 } }).error ?? '',
    /"argRepair\.maxPerSession" must be a non-negative integer/
  );
});

// ── Hook layer: repair-only mode shape ────────────────────────────────────

test('repair-only mode strips the audit pipeline hooks', async () => {
  await withCleanRepairEnv(async () => {
    const { input } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions());
    assert.equal(hooks.event, undefined);
    assert.equal(hooks.tool, undefined);
    assert.ok(!Object.keys(hooks).includes('experimental.chat.messages.transform'));
    assert.equal(typeof hooks['chat.message'], 'function');
    assert.equal(typeof hooks['tool.execute.before'], 'function');
  });
});

test('full mode keeps the audit pipeline hooks', async () => {
  await withCleanRepairEnv(async () => {
    const { input } = repairPluginInput();
    const hooks = await plugin.server(input);
    assert.equal(typeof hooks.event, 'function');
    assert.equal(typeof hooks.tool, 'object');
    assert.ok(Object.keys(hooks).includes('experimental.chat.messages.transform'));
  });
});

// ── Hook layer: the repair pass ───────────────────────────────────────────

test('repair-only mode repairs malformed question args in place via the model tier', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts, toolListQueries } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions());
    await dispatchChatMessage(hooks, 'repair-happy-1', { providerID: 'enmaas', modelID: 'glm-5-3' });
    const args: Record<string, unknown> = { questions: null };

    await dispatchToolBefore(hooks, 'repair-happy-1', 'question', args);

    assert.equal(promptTexts.length, 1);
    assert.ok(promptTexts[0].includes('question'));
    assert.ok(promptTexts[0].includes(EVIDENCE_REASONING));
    assert.deepEqual(args, { questions: VALID_QUESTIONS });
    assert.equal(toolListQueries.length, 1);
    assert.equal(toolListQueries[0].provider, 'enmaas');
    assert.equal(toolListQueries[0].model, 'glm-5-3');
  });
});

test('full mode repairs args and the guard does not block the call', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput();
    const hooks = await plugin.server(input);
    await dispatchChatMessage(hooks, 'repair-full-1', { providerID: 'enmaas', modelID: 'glm-5-3' });
    const args: Record<string, unknown> = { questions: null };

    await dispatchToolBefore(hooks, 'repair-full-1', 'question', args); // must not throw

    assert.deepEqual(args, { questions: VALID_QUESTIONS });
    assert.equal(promptTexts.length, 1);
  });
});

test('the repair pass fixes stringified arrays deterministically without a model call', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions());
    const args: Record<string, unknown> = { questions: JSON.stringify(VALID_QUESTIONS) };

    await dispatchToolBefore(hooks, 'repair-det-1', 'question', args);

    assert.deepEqual(args, { questions: VALID_QUESTIONS });
    assert.equal(promptTexts.length, 0);
  });
});

test('valid args pass through the repair pass untouched', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions());
    const args: Record<string, unknown> = { questions: VALID_QUESTIONS };

    await dispatchToolBefore(hooks, 'repair-valid-1', 'question', args);

    assert.deepEqual(args, { questions: VALID_QUESTIONS });
    assert.equal(promptTexts.length, 0);
  });
});

test('out-of-scope tools are left alone', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions());
    const args: Record<string, unknown> = { query: null };

    await dispatchToolBefore(hooks, 'repair-scope-1', 'dewey_search', args);

    assert.deepEqual(args, { query: null });
    assert.equal(promptTexts.length, 0);
  });
});

test('the per-session bound stops model repairs and leaves args to fail normally', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions({ maxPerSession: 1 }));
    await dispatchChatMessage(hooks, 'repair-bound-1', { providerID: 'enmaas', modelID: 'glm-5-3' });
    const first: Record<string, unknown> = { questions: null };
    await dispatchToolBefore(hooks, 'repair-bound-1', 'question', first);
    assert.deepEqual(first, { questions: VALID_QUESTIONS });

    const second: Record<string, unknown> = { questions: null };
    await dispatchToolBefore(hooks, 'repair-bound-1', 'question', second);

    assert.deepEqual(second, { questions: null });
    assert.equal(promptTexts.length, 1);
  });
});

test('an unrepairable verdict leaves args unchanged without throwing', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput({
      promptResponse: '{"unrepairable": true, "reason": "cannot recover the questions"}',
    });
    const hooks = await plugin.server(input, repairOnlyOptions());
    await dispatchChatMessage(hooks, 'repair-unrep-1', { providerID: 'enmaas', modelID: 'glm-5-3' });
    const args: Record<string, unknown> = { questions: null };

    await dispatchToolBefore(hooks, 'repair-unrep-1', 'question', args);

    assert.deepEqual(args, { questions: null });
    assert.equal(promptTexts.length, 1);
  });
});

test('a failing repair model fails open and leaves args unchanged', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput({ promptRejects: true });
    const hooks = await plugin.server(input, repairOnlyOptions());
    await dispatchChatMessage(hooks, 'repair-model-err-1', { providerID: 'enmaas', modelID: 'glm-5-3' });
    const args: Record<string, unknown> = { questions: null };

    await dispatchToolBefore(hooks, 'repair-model-err-1', 'question', args);

    assert.deepEqual(args, { questions: null });
    assert.equal(promptTexts.length, 1);
  });
});

test('a failing tool-schema lookup skips repair without throwing', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts, toolListQueries } = repairPluginInput({ toolListRejects: true });
    const hooks = await plugin.server(input, repairOnlyOptions());
    await dispatchChatMessage(hooks, 'repair-schema-err-1', { providerID: 'enmaas', modelID: 'glm-5-3' });
    const args: Record<string, unknown> = { questions: null };

    await dispatchToolBefore(hooks, 'repair-schema-err-1', 'question', args);

    assert.deepEqual(args, { questions: null });
    assert.equal(toolListQueries.length, 1);
    assert.equal(promptTexts.length, 0);
  });
});

test('argRepair.enabled false disables the repair pass', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions({ enabled: false }));
    await dispatchChatMessage(hooks, 'repair-off-1', { providerID: 'enmaas', modelID: 'glm-5-3' });
    const args: Record<string, unknown> = { questions: null };

    await dispatchToolBefore(hooks, 'repair-off-1', 'question', args);

    assert.deepEqual(args, { questions: null });
    assert.equal(promptTexts.length, 0);
  });
});

test('the fallback model identity drives the schema lookup without chat.message', async () => {
  await withCleanRepairEnv(async () => {
    const { input, promptTexts, toolListQueries } = repairPluginInput();
    const hooks = await plugin.server(input, repairOnlyOptions());
    const args: Record<string, unknown> = { questions: null };

    await dispatchToolBefore(hooks, 'repair-fallback-1', 'question', args);

    assert.deepEqual(args, { questions: VALID_QUESTIONS });
    assert.equal(toolListQueries.length, 1);
    assert.equal(toolListQueries[0].provider, 'enmaas');
    assert.equal(toolListQueries[0].model, 'glm-5-3');
    assert.equal(promptTexts.length, 1);
  });
});

test('directive repair rules extend the scope to non-builtin tools', async () => {
  await withCleanRepairEnv(async () => {
    const dir = makeDirectiveDir({
      'repair-dewey.md': directiveFile('Repair malformed dewey searches.', { repair: [{ tool: 'dewey_search' }] }),
    });
    const { input, promptTexts } = repairPluginInput({
      directory: dir,
      promptResponse: JSON.stringify({ args: { query: 'notes about GLM' } }),
    });
    const hooks = await plugin.server(input, repairOnlyOptions());
    const args: Record<string, unknown> = { query: null };

    await dispatchToolBefore(hooks, 'repair-directive-1', 'dewey_search', args);

    assert.deepEqual(args, { query: 'notes about GLM' });
    assert.equal(promptTexts.length, 1);
  });
});
