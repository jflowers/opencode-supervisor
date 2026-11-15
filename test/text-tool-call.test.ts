/**
 * Text tool-call recovery (FR-090..FR-095): unit tests for the pure
 * detector in src/text-tool-call.ts (shapes, code masking, tool-id
 * gating, last-turn assessment) and hook-layer tests driving the
 * session.idle path with a mock client (correction delivery, the
 * bound in a row, resets, duplicate idles, side and subagent
 * sessions, config, fail-open delivery).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { Hooks, PluginInput, PluginOptions } from '@opencode-ai/plugin';

import plugin, { resolveHookConfig } from '../index.ts';
import { withCleanSupervisorEnv } from './mocks.ts';
import {
  DEFAULT_TEXT_TOOL_CALL,
  assessLastTurn,
  detectTextToolCall,
  maskCode,
  textToolCallMessage,
  type TurnMessage,
} from '../src/text-tool-call.ts';
import { validateSupervisorConfig } from '../src/config-file.ts';

const TOOLS = new Set(['question', 'bash', 'read', 'todowrite']);

/** The shape observed from GLM 5.3 on EnMaaS (#65). */
const INVOKE_TEXT =
  'Item 12 of 18 is ready for your call.\n\n' +
  '<invoke name="question">\n' +
  '<parameter name="questions">[{"question": "Item 12 of 18 — keep the Tier 2 panel?"}]</parameter>\n' +
  '</invoke>';

// ── Detection (FR-090) ───────────────────────────────────────────────

test('detectTextToolCall finds an invoke block naming a registered tool', () => {
  assert.deepEqual(detectTextToolCall(INVOKE_TEXT, TOOLS), { tool: 'question', shape: 'invoke' });
});

test('detectTextToolCall accepts a namespaced invoke and single quotes', () => {
  assert.deepEqual(detectTextToolCall("<ns:invoke name='bash'>x</ns:invoke>", TOOLS), {
    tool: 'bash',
    shape: 'invoke',
  });
});

test('detectTextToolCall reports invoke inside function_calls as function_calls', () => {
  const text = 'Running it.\n<function_calls>\n<invoke name="read">\n<parameter name="filePath">a.ts</parameter>\n</invoke>\n</function_calls>';
  assert.deepEqual(detectTextToolCall(text, TOOLS), { tool: 'read', shape: 'function_calls' });
});

test('detectTextToolCall finds a tool_call block with a JSON body', () => {
  const text = 'Next:\n<tool_call>\n{"name": "todowrite", "arguments": {"todos": []}}\n</tool_call>';
  assert.deepEqual(detectTextToolCall(text, TOOLS), { tool: 'todowrite', shape: 'tool_call' });
});

test('detectTextToolCall finds a tool_call block with a leading tool name (GLM template)', () => {
  const text = '<tool_call>question\n<arg_key>questions</arg_key>\n<arg_value>[]</arg_value>\n</tool_call>';
  assert.deepEqual(detectTextToolCall(text, TOOLS), { tool: 'question', shape: 'tool_call' });
});

test('detectTextToolCall finds a bare name/arguments JSON object', () => {
  const text = 'Calling now: {"name": "bash", "arguments": {"command": "bun test"}}';
  assert.deepEqual(detectTextToolCall(text, TOOLS), { tool: 'bash', shape: 'json' });
});

test('detectTextToolCall ignores calls inside fenced code blocks', () => {
  const backticks = 'The model wrote this instead of calling:\n\n```xml\n<invoke name="question">\n</invoke>\n```\n';
  const tildes = 'Example:\n~~~\n{"name": "bash", "arguments": {}}\n~~~';
  assert.equal(detectTextToolCall(backticks, TOOLS), null);
  assert.equal(detectTextToolCall(tildes, TOOLS), null);
});

test('detectTextToolCall ignores an unclosed fence through the end of the text', () => {
  assert.equal(detectTextToolCall('Example:\n```\n<invoke name="question">', TOOLS), null);
});

test('detectTextToolCall ignores calls inside inline code', () => {
  assert.equal(detectTextToolCall('Models sometimes emit `<invoke name="question">` as text.', TOOLS), null);
});

test('detectTextToolCall ignores tool names that are not registered', () => {
  assert.equal(detectTextToolCall('<invoke name="launch_rockets">go</invoke>', TOOLS), null);
  assert.equal(detectTextToolCall('{"name": "Alice", "arguments": "none"}', TOOLS), null);
});

test('detectTextToolCall finds nothing in plain prose or with no tools', () => {
  assert.equal(detectTextToolCall('All 18 items are addressed.', TOOLS), null);
  assert.equal(detectTextToolCall(INVOKE_TEXT, new Set()), null);
});

test('maskCode keeps prose and line structure while blanking code', () => {
  const masked = maskCode('a `b` c\n```\nd\n```\ne');
  assert.equal(masked.split('\n').length, 5);
  assert.ok(masked.startsWith('a '));
  assert.ok(!masked.includes('b'));
  assert.ok(!masked.includes('d'));
  assert.ok(masked.endsWith('e'));
});

// ── Last-turn assessment (FR-090, design D2) ─────────────────────────

function assistant(parts: TurnMessage['parts'], info: Partial<TurnMessage['info']> = {}): TurnMessage {
  return { info: { id: 'a1', role: 'assistant', ...info }, parts };
}

test('assessLastTurn detects a text tool call in the final text part', () => {
  const messages = [assistant([{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: INVOKE_TEXT }])];
  assert.deepEqual(assessLastTurn(messages, TOOLS), {
    messageID: 'a1',
    detection: { tool: 'question', shape: 'invoke' },
  });
});

test('assessLastTurn leaves a turn alone when a tool part follows the text', () => {
  const messages = [assistant([{ type: 'text', text: INVOKE_TEXT }, { type: 'tool' }])];
  assert.deepEqual(assessLastTurn(messages, TOOLS), { messageID: 'a1', detection: null });
});

test('assessLastTurn skips errored turns, user messages, and text-less turns', () => {
  assert.equal(assessLastTurn([assistant([{ type: 'text', text: INVOKE_TEXT }], { error: { name: 'Aborted' } })], TOOLS), null);
  assert.equal(assessLastTurn([{ info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: INVOKE_TEXT }] }], TOOLS), null);
  assert.equal(assessLastTurn([assistant([{ type: 'reasoning', text: INVOKE_TEXT }])], TOOLS), null);
  assert.equal(assessLastTurn([], TOOLS), null);
});

test('textToolCallMessage names the tool and asks for the real call', () => {
  const message = textToolCallMessage({ tool: 'question', shape: 'invoke' });
  assert.match(message, /`question` tool call as text/);
  assert.match(message, /Make the actual tool call now; don't repeat the text\./);
});

// ── Config (FR-094) ──────────────────────────────────────────────────

test('textToolCall defaults to enabled with two corrections in a row', () => {
  assert.deepEqual(DEFAULT_TEXT_TOOL_CALL, { enabled: true, maxPerSession: 2 });
  return withCleanSupervisorEnv(async () => {
    assert.deepEqual(resolveHookConfig().textToolCall, { enabled: true, maxPerSession: 2 });
  });
});

test('textToolCall resolves env over files and files over defaults', () =>
  withCleanSupervisorEnv(async () => {
    const sources = { project: { textToolCall: { maxPerSession: 5 } }, global: { textToolCall: { enabled: false } } };
    assert.deepEqual(resolveHookConfig(undefined, sources).textToolCall, { enabled: false, maxPerSession: 5 });
    process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL = 'true';
    process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL_MAX = '1';
    try {
      assert.deepEqual(resolveHookConfig(undefined, sources).textToolCall, { enabled: true, maxPerSession: 1 });
    } finally {
      delete process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL;
      delete process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL_MAX;
    }
  }));

test('config files validate textToolCall and reject wrong types', () => {
  assert.deepEqual(validateSupervisorConfig({ textToolCall: { enabled: false, maxPerSession: 3 } }).config.textToolCall, {
    enabled: false,
    maxPerSession: 3,
  });
  assert.match(validateSupervisorConfig({ textToolCall: 'off' }).error ?? '', /"textToolCall" must be an object/);
  assert.match(validateSupervisorConfig({ textToolCall: { enabled: 'no' } }).error ?? '', /textToolCall\.enabled/);
  assert.match(validateSupervisorConfig({ textToolCall: { maxPerSession: -1 } }).error ?? '', /textToolCall\.maxPerSession/);
});

// ── Hook layer (FR-091..FR-095) ──────────────────────────────────────

interface HarnessOptions {
  parentID?: string;
  promptAsyncFails?: boolean;
  toolListFails?: boolean;
}

/** A mock client whose last message the test controls; records steers and log lines. */
function harness(options: HarnessOptions = {}) {
  const state = {
    messages: [] as unknown[],
    steers: [] as Array<{ sessionID: string; text: string; synthetic: unknown }>,
    logs: [] as Array<{ level: string; message: string }>,
    messageFetches: 0,
  };
  const input = {
    client: {
      session: {
        create: async () => ({ data: { id: 'mock-side-session' } }),
        prompt: async () => ({ data: { info: {}, parts: [] } }),
        promptAsync: async (request: unknown) => {
          const { path, body } = request as {
            path: { id: string };
            body: { parts: Array<{ text: string; synthetic?: unknown }> };
          };
          if (options.promptAsyncFails === true) {
            return { error: { name: 'Unavailable' } };
          }
          state.steers.push({ sessionID: path.id, text: body.parts[0]!.text, synthetic: body.parts[0]!.synthetic });
          return {};
        },
        abort: async () => ({}),
        delete: async () => ({}),
        get: async (request: unknown) => {
          const id = (request as { path: { id: string } }).path.id;
          return { data: { id, parentID: options.parentID } };
        },
        messages: async () => {
          state.messageFetches += 1;
          return { data: state.messages };
        },
      },
      tool: {
        list: async () => {
          if (options.toolListFails === true) {
            throw new Error('tool list unavailable');
          }
          return { data: [...TOOLS].map((id) => ({ id, description: id, parameters: { type: 'object' } })) };
        },
      },
      app: {
        log: async (request: unknown) => {
          const body = (request as { body?: { level?: string; message?: string } }).body;
          state.logs.push({ level: body?.level ?? '', message: body?.message ?? '' });
          return {};
        },
      },
      config: { get: async () => ({ data: {} }) },
    },
    directory: '/tmp/supervisor-text-tool-call-test',
  };
  return { input: input as unknown as PluginInput, state, options };
}

let messageSeq = 0;

/** Ends the session's turn with one assistant message carrying `text` (and optional trailing parts). */
function endTurn(state: { messages: unknown[] }, text: string, trailing: unknown[] = []): void {
  messageSeq += 1;
  state.messages = [
    { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'Address the feedback.' }] },
    {
      info: { id: `a${messageSeq}`, role: 'assistant', providerID: 'enmaas', modelID: 'glm-5.3' },
      parts: [{ type: 'text', text }, ...trailing],
    },
  ];
}

function idle(hooks: Hooks, sessionID: string): Promise<void> {
  return hooks.event!({ event: { type: 'session.idle', properties: { sessionID } } } as never);
}

function statusIdle(hooks: Hooks, sessionID: string): Promise<void> {
  return hooks.event!({
    event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
  } as never);
}

async function load(input: PluginInput, options?: Record<string, unknown>): Promise<Hooks> {
  return plugin.server(input, (options === undefined ? undefined : { config: options }) as unknown as PluginOptions);
}

test('an idle turn ending with a text tool call is steered to make the call', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-steer');
    assert.equal(state.steers.length, 1);
    assert.equal(state.steers[0]!.sessionID, 'ttc-steer');
    assert.equal(state.steers[0]!.synthetic, true);
    assert.match(state.steers[0]!.text, /`question` tool call as text/);
    assert.ok(state.logs.some((entry) => entry.level === 'warn' && /text tool call detected/.test(entry.message)));
    assert.ok(state.logs.some((entry) => entry.level === 'info' && /correction 1\/2 sent/.test(entry.message)));
  }));

test('a turn that ends with a real tool part is not touched', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endTurn(state, INVOKE_TEXT, [{ type: 'tool', tool: 'question', callID: 'c1' }]);
    await idle(hooks, 'ttc-real-call');
    assert.equal(state.steers.length, 0);
  }));

test('a fenced example in the final message is not steered', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endTurn(state, 'Here is the shape GLM emits:\n```\n<invoke name="question">\n</invoke>\n```');
    await idle(hooks, 'ttc-fenced');
    assert.equal(state.steers.length, 0);
  }));

test('the two idle notifications of one turn steer once', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endTurn(state, INVOKE_TEXT);
    await Promise.all([idle(hooks, 'ttc-double'), statusIdle(hooks, 'ttc-double')]);
    await idle(hooks, 'ttc-double');
    assert.equal(state.steers.length, 1);
  }));

test('corrections stop at the bound in a row and the session stays idle', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    for (let turn = 0; turn < 3; turn++) {
      endTurn(state, INVOKE_TEXT);
      await idle(hooks, 'ttc-cap');
    }
    assert.equal(state.steers.length, 2);
    assert.ok(state.logs.some((entry) => /correction bound \(2\) reached/.test(entry.message)));
  }));

test('a clean turn or a human message resets the run of corrections', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input, { textToolCall: { maxPerSession: 1 } });
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-reset');
    endTurn(state, 'Done with item 12.');
    await idle(hooks, 'ttc-reset');
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-reset');
    assert.equal(state.steers.length, 2, 'a clean turn resets the streak');
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-reset');
    assert.equal(state.steers.length, 2, 'capped');
    const chat = hooks['chat.message'] as unknown as (input: unknown, output: unknown) => Promise<void>;
    await chat(
      { sessionID: 'ttc-reset' },
      { message: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: 'Keep going.' }] }
    );
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-reset');
    assert.equal(state.steers.length, 3, 'a human message resets the streak');
  }));

test('the synthetic steer itself does not reset the run', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input, { textToolCall: { maxPerSession: 1 } });
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-synthetic');
    const chat = hooks['chat.message'] as unknown as (input: unknown, output: unknown) => Promise<void>;
    await chat(
      { sessionID: 'ttc-synthetic' },
      { message: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: state.steers[0]!.text, synthetic: true }] }
    );
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-synthetic');
    assert.equal(state.steers.length, 1);
  }));

test('a subagent session is logged but not steered', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness({ parentID: 'ttc-parent' });
    const hooks = await load(input);
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-child');
    assert.equal(state.steers.length, 0);
    assert.ok(state.logs.some((entry) => /subagent session; no correction sent/.test(entry.message)));
  }));

test('disabled through the environment, the check never reads messages', () =>
  withCleanSupervisorEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL = 'false';
    try {
      const { input, state } = harness();
      const hooks = await load(input);
      endTurn(state, INVOKE_TEXT);
      await idle(hooks, 'ttc-disabled');
      assert.equal(state.steers.length, 0);
      assert.equal(state.messageFetches, 0);
    } finally {
      delete process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL;
    }
  }));

test('a failed delivery fails open and does not spend the bound', () =>
  withCleanSupervisorEnv(async () => {
    const failing = harness({ promptAsyncFails: true });
    const hooks = await load(failing.input, { textToolCall: { maxPerSession: 1 } });
    endTurn(failing.state, INVOKE_TEXT);
    await idle(hooks, 'ttc-fail');
    assert.ok(failing.state.logs.some((entry) => entry.level === 'error' && /correction failed open/.test(entry.message)));
    failing.options.promptAsyncFails = false;
    endTurn(failing.state, INVOKE_TEXT);
    await idle(hooks, 'ttc-fail');
    assert.equal(failing.state.steers.length, 1, 'the failed attempt left the one slot free');
  }));

test('an unavailable tool list skips the check without throwing', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness({ toolListFails: true });
    const hooks = await load(input);
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-no-tools');
    assert.equal(state.steers.length, 0);
  }));

test('repair-only mode registers no idle check', () =>
  withCleanSupervisorEnv(async () => {
    const { input } = harness();
    const hooks = await load(input, { mode: 'repair-only' });
    assert.equal(hooks.event, undefined);
  }));
