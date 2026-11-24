/**
 * Text tool-call recovery (FR-090..FR-095): unit tests for the pure
 * detector in src/text-tool-call.ts (shapes, code masking, tool-id
 * gating, last-turn assessment) and hook-layer tests driving the
 * session.idle path with a mock client (correction delivery, the
 * bound in a row, resets, duplicate idles, side and subagent
 * sessions, config, fail-open delivery). Subagent recovery
 * (FR-096..FR-098): task-result helpers and hook-layer tests driving
 * the parent's tool.execute.after for a completed task call.
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
  lastTextOf,
  maskCode,
  parseTaskResult,
  replaceTaskResult,
  subagentTextToolCallNote,
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
  /**
   * Invoked from inside the promptAsync mock before it resolves, so a test
   * can land a human chat.message while a correction delivery is in flight
   * (the streak-reset race, review round 1).
   */
  resetDuringDelivery?: (input: unknown, output: unknown) => Promise<void>;
  /** Final texts the subagent answers corrections with, in order (default 'Done.'). */
  subagentReplies?: string[];
  /** The subagent correction prompt returns an error result. */
  subagentPromptFails?: boolean;
}

/** A mock client whose last message the test controls; records steers and log lines. */
function harness(options: HarnessOptions = {}) {
  const state = {
    messages: [] as unknown[],
    steers: [] as Array<{ sessionID: string; text: string; synthetic: unknown; agent?: unknown; model?: unknown }>,
    logs: [] as Array<{ level: string; message: string }>,
    messageFetches: 0,
    messageQueries: [] as Array<unknown>,
    subagentPrompts: [] as Array<{ sessionID: string; body: Record<string, unknown> }>,
  };
  const input = {
    client: {
      session: {
        create: async () => ({ data: { id: 'mock-side-session' } }),
        prompt: async (request: unknown) => {
          const { path, body } = request as { path: { id: string }; body: Record<string, unknown> };
          if (path.id === 'mock-side-session') {
            return { data: { info: {}, parts: [] } };
          }
          state.subagentPrompts.push({ sessionID: path.id, body });
          if (options.subagentPromptFails === true) {
            return { error: { name: 'Unavailable' } };
          }
          const text = options.subagentReplies?.shift() ?? 'Done.';
          return {
            data: {
              info: { id: `r${state.subagentPrompts.length}`, role: 'assistant', providerID: 'enmaas', modelID: 'glm-5.3' },
              parts: [{ type: 'text', text }],
            },
          };
        },
        promptAsync: async (request: unknown) => {
          const { path, body } = request as {
            path: { id: string };
            body: { parts: Array<{ text: string; synthetic?: unknown }>; agent?: unknown; model?: unknown };
          };
          if (options.resetDuringDelivery !== undefined) {
            await options.resetDuringDelivery(
              { sessionID: path.id },
              { message: { id: `u-race`, role: 'user' }, parts: [{ type: 'text', text: 'Human interjection.' }] }
            );
          }
          if (options.promptAsyncFails === true) {
            return { error: { name: 'Unavailable' } };
          }
          state.steers.push({
            sessionID: path.id,
            text: body.parts[0]!.text,
            synthetic: body.parts[0]!.synthetic,
            agent: body.agent,
            model: body.model,
          });
          return {};
        },
        abort: async () => ({}),
        delete: async () => ({}),
        get: async (request: unknown) => {
          const id = (request as { path: { id: string } }).path.id;
          return { data: { id, parentID: options.parentID } };
        },
        messages: async (request: unknown) => {
          state.messageFetches += 1;
          state.messageQueries.push((request as { query?: unknown }).query ?? null);
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
    assert.ok(state.logs.some((entry) => /subagent session; correction is handled at its parent's task call/.test(entry.message)));
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

test('the correction runs under the agent and model of the latest user message (FR-112)', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    const chat = hooks['chat.message'] as unknown as (input: unknown, output: unknown) => Promise<void>;
    await chat(
      { sessionID: 'ttc-target', agent: 'reviewer', model: { providerID: 'acme', modelID: 'model-x' } },
      { message: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'Address the feedback.' }] }
    );
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-target');
    assert.equal(state.steers.length, 1);
    assert.equal(state.steers[0]!.agent, 'reviewer');
    assert.deepEqual(state.steers[0]!.model, { providerID: 'acme', modelID: 'model-x' });
  }));

test('without chat.message state the correction takes the turn\'s own agent and model (FR-112)', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endTurn(state, INVOKE_TEXT);
    (state.messages[1] as { info: Record<string, unknown> }).info.agent = 'cobalt-crush-dev';
    await idle(hooks, 'ttc-target-fallback');
    assert.equal(state.steers.length, 1);
    assert.equal(state.steers[0]!.agent, 'cobalt-crush-dev');
    assert.deepEqual(state.steers[0]!.model, { providerID: 'enmaas', modelID: 'glm-5.3' });
    assert.deepEqual(state.messageQueries, [{ limit: 1 }], 'no second fetch for the steer target');
  }));

test('the idle check fetches only the last message (bounded query)', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endTurn(state, INVOKE_TEXT);
    await idle(hooks, 'ttc-bounded');
    assert.equal(state.steers.length, 1);
    assert.deepEqual(
      state.messageQueries,
      [{ limit: 1 }],
      'every idle fetch must bound the transcript transfer'
    );
  }));

test('a human message landing during a failed delivery keeps the streak non-negative', () =>
  withCleanSupervisorEnv(async () => {
    const racing = harness({ promptAsyncFails: true });
    const hooks = await load(racing.input, { textToolCall: { maxPerSession: 1 } });
    const chat = hooks['chat.message'] as unknown as (input: unknown, output: unknown) => Promise<void>;
    racing.options.resetDuringDelivery = chat;
    endTurn(racing.state, INVOKE_TEXT);
    await idle(hooks, 'ttc-race');
    assert.ok(
      racing.state.logs.some((entry) => entry.level === 'error' && /correction failed open/.test(entry.message)),
      'the delivery failed after the human message reset the run'
    );
    racing.options.promptAsyncFails = false;
    racing.options.resetDuringDelivery = undefined;
    endTurn(racing.state, INVOKE_TEXT);
    await idle(hooks, 'ttc-race');
    assert.equal(racing.state.steers.length, 1, 'the reset run still has its full bound');
    endTurn(racing.state, INVOKE_TEXT);
    await idle(hooks, 'ttc-race');
    assert.equal(racing.state.steers.length, 1, 'capped at the bound — the failed release never went below zero');
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

// ── Subagent recovery at the task boundary (FR-096..FR-098) ──────────

function taskOutput(sessionID: string, text: string): string {
  return [`<task id="${sessionID}" state="completed">`, '<task_result>', text, '</task_result>', '</task>'].join('\n');
}

test('parseTaskResult and replaceTaskResult read and rewrite a completed task body', () => {
  const output = taskOutput('ses_child', 'line one\n<task_result>quoted</task_result>\nline two');
  assert.equal(parseTaskResult(output), 'line one\n<task_result>quoted</task_result>\nline two');
  assert.equal(replaceTaskResult(output, 'Done.'), taskOutput('ses_child', 'Done.'));
  assert.equal(parseTaskResult(taskOutput('ses_child', '')), '');
});

test('parseTaskResult rejects running, errored, and unframed outputs', () => {
  const running = taskOutput('ses_child', 'x').replace('state="completed"', 'state="running"');
  assert.equal(parseTaskResult(running), null);
  assert.equal(parseTaskResult('<task id="s" state="error">\n<task_error>\nboom\n</task_error>\n</task>'), null);
  assert.equal(parseTaskResult('plain text'), null);
  assert.equal(replaceTaskResult('plain text', 'x'), null);
});

test('lastTextOf returns the last text part, like the task tool', () => {
  assert.equal(lastTextOf([{ type: 'text', text: 'a' }, { type: 'tool' }, { type: 'text', text: 'b' }, { type: 'reasoning' }]), 'b');
  assert.equal(lastTextOf([{ type: 'tool' }]), '');
  assert.equal(lastTextOf(undefined), '');
});

test('subagentTextToolCallNote names the tool and marks the result incomplete', () => {
  const note = subagentTextToolCallNote({ tool: 'question', shape: 'invoke' });
  assert.match(note, /`question` tool call as text/);
  assert.match(note, /incomplete/);
});

/** Ends the subagent's turn: its last message, with the subagent's agent. */
function endSubagentTurn(state: { messages: unknown[] }, text: string): void {
  messageSeq += 1;
  state.messages = [
    {
      info: { id: `s${messageSeq}`, role: 'assistant', providerID: 'enmaas', modelID: 'glm-5.3', mode: 'reviewer', agent: 'reviewer' },
      parts: [{ type: 'text', text }],
    },
  ];
}

function taskAfter(
  hooks: Hooks,
  output: { title: string; output: string; metadata: Record<string, unknown> }
): Promise<void> {
  const after = hooks['tool.execute.after'] as unknown as (input: unknown, output: unknown) => Promise<void>;
  return after({ tool: 'task', sessionID: 'ttc-parent', callID: 'call-1', args: {} }, output);
}

function completedTask(childID: string, text: string, metadata: Record<string, unknown> = {}) {
  return { title: 'Review', output: taskOutput(childID, text), metadata: { sessionId: childID, ...metadata } };
}

test('a subagent that wrote a tool call as text is corrected before its parent sees the result', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness({ subagentReplies: ['Asked the question; the engineer chose Tier 2.'] });
    const hooks = await load(input);
    endSubagentTurn(state, INVOKE_TEXT);
    const output = completedTask('ttc-sub', INVOKE_TEXT);
    await taskAfter(hooks, output);
    assert.equal(state.subagentPrompts.length, 1);
    const prompt = state.subagentPrompts[0]!;
    assert.equal(prompt.sessionID, 'ttc-sub');
    assert.equal(prompt.body.agent, 'reviewer');
    assert.deepEqual(prompt.body.model, { providerID: 'enmaas', modelID: 'glm-5.3' });
    const part = (prompt.body.parts as Array<{ text: string; synthetic?: unknown }>)[0]!;
    assert.equal(part.synthetic, true);
    assert.match(part.text, /`question` tool call as text/);
    assert.equal(output.output, taskOutput('ttc-sub', 'Asked the question; the engineer chose Tier 2.'));
    assert.equal(state.steers.length, 0, 'no async steer: the correction is synchronous');
  }));

test('a clean subagent result is left untouched', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endSubagentTurn(state, 'All 18 items addressed.');
    const output = completedTask('ttc-sub-clean', 'All 18 items addressed.');
    await taskAfter(hooks, output);
    assert.equal(state.subagentPrompts.length, 0);
    assert.equal(output.output, taskOutput('ttc-sub-clean', 'All 18 items addressed.'));
  }));

test('a subagent still writing the call at the bound gets a note in the parent result', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness({ subagentReplies: [INVOKE_TEXT, INVOKE_TEXT, INVOKE_TEXT] });
    const hooks = await load(input);
    endSubagentTurn(state, INVOKE_TEXT);
    const output = completedTask('ttc-sub-cap', INVOKE_TEXT);
    await taskAfter(hooks, output);
    assert.equal(state.subagentPrompts.length, 2, 'bounded by maxPerSession');
    const body = parseTaskResult(output.output)!;
    assert.ok(body.startsWith(INVOKE_TEXT));
    assert.ok(body.endsWith(subagentTextToolCallNote({ tool: 'question', shape: 'invoke' })));
    assert.ok(state.logs.some((entry) => /correction bound \(2\) reached for subagent session/.test(entry.message)));
  }));

test('a background task is skipped without reading the subagent', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endSubagentTurn(state, INVOKE_TEXT);
    const output = completedTask('ttc-sub-bg', INVOKE_TEXT, { background: true });
    await taskAfter(hooks, output);
    assert.equal(state.messageFetches, 0);
    assert.equal(output.output, taskOutput('ttc-sub-bg', INVOKE_TEXT));
  }));

test('a failed subagent correction fails open with a note and does not spend the bound', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness({ subagentPromptFails: true });
    const hooks = await load(input, { textToolCall: { maxPerSession: 1 } });
    endSubagentTurn(state, INVOKE_TEXT);
    const first = completedTask('ttc-sub-fail', INVOKE_TEXT);
    await taskAfter(hooks, first);
    assert.match(parseTaskResult(first.output)!, /This result is incomplete\.$/);
    assert.ok(state.logs.some((entry) => entry.level === 'error' && /subagent text tool-call correction failed open/.test(entry.message)));
    const second = completedTask('ttc-sub-fail', INVOKE_TEXT);
    await taskAfter(hooks, second);
    assert.equal(state.subagentPrompts.length, 2, 'the failed delivery released its slot');
  }));

test('disabled through the environment, the task boundary never reads the subagent', () =>
  withCleanSupervisorEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL = 'false';
    try {
      const { input, state } = harness();
      const hooks = await load(input);
      endSubagentTurn(state, INVOKE_TEXT);
      const output = completedTask('ttc-sub-off', INVOKE_TEXT);
      await taskAfter(hooks, output);
      assert.equal(state.messageFetches, 0);
      assert.equal(output.output, taskOutput('ttc-sub-off', INVOKE_TEXT));
    } finally {
      delete process.env.OPENCODE_SUPERVISOR_TEXT_TOOL_CALL;
    }
  }));

test('a non-task tool or an unframed task output is ignored at the boundary', () =>
  withCleanSupervisorEnv(async () => {
    const { input, state } = harness();
    const hooks = await load(input);
    endSubagentTurn(state, INVOKE_TEXT);
    const after = hooks['tool.execute.after'] as unknown as (input: unknown, output: unknown) => Promise<void>;
    await after({ tool: 'bash', sessionID: 'ttc-parent', callID: 'c', args: {} }, completedTask('ttc-sub-x', INVOKE_TEXT));
    const unframed = { title: 'Review', output: INVOKE_TEXT, metadata: { sessionId: 'ttc-sub-x' } };
    await taskAfter(hooks, unframed);
    assert.equal(state.messageFetches, 0);
    assert.equal(unframed.output, INVOKE_TEXT);
  }));
