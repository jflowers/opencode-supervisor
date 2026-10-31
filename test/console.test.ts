/**
 * Agent-console second slice (FR-033..FR-042): module, memo, and hook-layer
 * tests for recall, report, and request_audit — the same harness shape as
 * test/reminders.test.ts (first slice) so the two slices read alike.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks, PluginInput, ToolContext } from '@opencode-ai/plugin';
import plugin, { sessionState } from '../index.ts';
import {
  addReport,
  CRITIQUE_RETENTION_CAP,
  MAX_REPORT_TEXT,
  prepareReportText,
  renderRecall,
  renderReports,
  REPORT_KINDS,
  SOLVED_RETENTION_CAP,
  type AgentReport,
} from '../src/console.ts';
import { buildMemo } from '../src/memo.ts';
import { silentClientSurface, silentPluginInput } from './mocks.ts';

/** A stored report with a fixed timestamp — the module never touches the clock. */
function report(kind: AgentReport['kind'], text: string): AgentReport {
  return { kind, text, addedAt: '2026-10-25T00:00:00.000Z' };
}

/** Minimal ToolContext: the tools only read `sessionID`. */
function toolContext(sessionID: string): ToolContext {
  return { sessionID } as unknown as ToolContext;
}

/** Event-hook input shape, for casting deliberately undeclared event payloads. */
type EventHookInput = Parameters<NonNullable<Hooks['event']>>[0];

/** A synthetic completed reasoning part (the SDK's terminal publication shape). */
function completedReasoningPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'part-1',
    sessionID: 'event-session-1',
    messageID: 'msg-1',
    type: 'reasoning',
    text: 'the rate = 24 * 15 = 360',
    time: { start: 1, end: 2 },
    ...overrides,
  };
}

/** Dispatches one message.part.updated event through the hook. */
function dispatchPart(hooks: Hooks, part: unknown): Promise<void> {
  return hooks.event!({ event: { type: 'message.part.updated', properties: { part } } } as unknown as EventHookInput);
}

/** Dispatches one tool.execute.after through the hook with a raw output. */
function dispatchToolAfter(hooks: Hooks, sessionID: string, tool: string, output: unknown): Promise<void> {
  return hooks['tool.execute.after']!({ tool, sessionID, callID: 'call-1', args: {} }, output);
}

/** A session message in the messages-transform payload shape. */
function sessionMessage(sessionID: string): Record<string, unknown> {
  return {
    info: { id: 'msg-1', sessionID, role: 'user', time: { created: 1 } },
    parts: [{ type: 'text', text: 'user turn' }],
  };
}

/** Dispatches one memo messages-transform invocation; returns the payload. */
async function dispatchMemoTransform(hooks: Hooks, sessionID: string): Promise<unknown[]> {
  const messages: unknown[] = [sessionMessage(sessionID)];
  const dispatch = hooks['experimental.chat.messages.transform'] as
    | ((input: unknown, output: unknown) => Promise<void>)
    | undefined;
  await dispatch?.(undefined, { messages });
  return messages;
}

/** Extracts a messages-transform message's text (joined text parts). */
function messageText(message: unknown): string {
  const parts = (message as { parts?: Array<{ type?: string; text?: unknown }> }).parts ?? [];
  return parts.filter((part) => part.type === 'text').map((part) => String(part.text)).join('\n');
}

/** Every OPENCODE_SUPERVISOR_* knob, for env-cleaning around hook-layer tests. */
const CONSOLE_ENV_NAMES = [
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
];

/** Saves/deletes the supervisor env knobs and isolates XDG_CONFIG_HOME around `run`, restoring after. */
async function withCleanConsoleEnv(run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of CONSOLE_ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // Isolate the global config tier (review round 5): a real
  // ~/.config/opencode/supervisor/config.json on the host must not
  // leak into tier resolution through XDG_CONFIG_HOME.
  const savedXdgHome = process.env.XDG_CONFIG_HOME;
  const isolatedXdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  process.env.XDG_CONFIG_HOME = isolatedXdgRoot;
  try {
    await run();
  } finally {
    for (const name of CONSOLE_ENV_NAMES) {
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

/**
 * A plugin input whose side-session prompt replies with `response`, tracking
 * every client call — for request_audit tests that need the model path.
 */
function auditInput(response: string): { input: PluginInput; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { create: [], prompt: [], promptAsync: [], abort: [], delete: [] };
  const input = {
    client: {
      session: {
        create: async (options: unknown) => {
          calls.create.push(options);
          return { data: { id: `side-${calls.create.length}` } };
        },
        prompt: async (request: unknown) => {
          calls.prompt.push(request);
          return { data: { info: {}, parts: [{ type: 'text', text: response }] } };
        },
        promptAsync: async (options: unknown) => {
          calls.promptAsync.push(options);
          return {};
        },
        abort: async (options: unknown) => {
          calls.abort.push(options);
          return {};
        },
        delete: async (options: unknown) => {
          calls.delete.push(options);
          return {};
        },
      },
      ...silentClientSurface,
    },
    directory: '/tmp/supervisor-test',
  };
  return { input: input as unknown as PluginInput, calls };
}

/** The audit-passed reply the side-session model returns. */
const PASSED_AUDIT = '{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}';

// ── Pure module: prepareReportText (FR-034) ──

test('prepareReportText trims and accepts ordinary text', () => {
  const prepared = prepareReportText('  the auth service is down  ');
  assert.deepEqual(prepared, { ok: true, text: 'the auth service is down', truncated: false });
});

test('prepareReportText rejects whitespace-only text with an actionable error', () => {
  const prepared = prepareReportText('   \n\t  ');
  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.ok(prepared.error.includes('state the event to report'));
  }
});

test('prepareReportText truncates over-length text at the fixed ceiling', () => {
  assert.equal(MAX_REPORT_TEXT, 2000);
  const prepared = prepareReportText('a'.repeat(2500));
  assert.deepEqual(prepared, { ok: true, text: 'a'.repeat(2000), truncated: true });
});

// ── Pure module: addReport (FR-035) ──

test('addReport appends and bounds storage to the most recent entries', () => {
  const start = [report('note', 'first')];
  const two = addReport(start, report('blocker', 'second'), 2);
  assert.deepEqual(two.map((entry) => entry.text), ['first', 'second']);
  const three = addReport(two, report('note', 'third'), 2);
  assert.deepEqual(three.map((entry) => entry.text), ['second', 'third']);
  // Pure: the inputs are untouched.
  assert.equal(start.length, 1);
  assert.equal(two.length, 2);
});

test('addReport stores nothing when the cap is zero', () => {
  const next = addReport([report('note', 'first')], report('note', 'second'), 0);
  assert.deepEqual(next, []);
});

// ── Pure module: renderReports (FR-036) ──

test('renderReports lists reports with their kinds, most recent last', () => {
  const section = renderReports([report('blocker', 'the auth service is down'), report('note', 'retry at 09:00')], 10);
  assert.equal(section, 'Agent reports:\n- [blocker] the auth service is down\n- [note] retry at 09:00');
});

test('renderReports returns null when empty or capped to zero', () => {
  assert.equal(renderReports([], 10), null);
  assert.equal(renderReports([report('note', 'first')], 0), null);
});

test('renderReports keeps the most recent reports within the cap', () => {
  const section = renderReports(
    [report('note', 'first'), report('note', 'second'), report('note', 'third')],
    2
  );
  assert.equal(section, 'Agent reports:\n- [note] second\n- [note] third');
});

// ── Pure module: renderRecall (FR-033) ──

test('renderRecall renders each stored section in full', () => {
  const input = {
    goal: 'ship the supervisor',
    reminders: [{ id: 'r1', text: 'use bash 4.5', addedAt: '2026-10-25T00:00:00.000Z' }],
    solvedItems: [{ tool: 'bash', outcome: 'tests passed' }],
    critiques: [{ text: 'arithmetic slipped', severity: 'minor', delivered: true }],
  };
  assert.equal(renderRecall('goal', input), 'Session goal:\nship the supervisor');
  assert.equal(renderRecall('reminders', input), 'Reminders:\n- r1: use bash 4.5');
  assert.equal(renderRecall('solved', input), 'Solved items:\n- bash: tests passed');
  assert.equal(renderRecall('critiques', input), 'Critiques:\n- [minor, delivered] arithmetic slipped');
});

test('renderRecall states an empty section plainly', () => {
  const input = { reminders: [], solvedItems: [], critiques: [] };
  assert.equal(renderRecall('goal', input), 'No goal is stored for this session.');
  assert.equal(renderRecall('reminders', input), 'No reminders are stored for this session.');
  assert.equal(renderRecall('solved', input), 'No solved items are stored for this session.');
  assert.equal(renderRecall('critiques', input), 'No critiques are stored for this session.');
});

test('renderRecall renders every section for all', () => {
  const input = {
    goal: 'ship the supervisor',
    reminders: [],
    solvedItems: [{ tool: 'bash', outcome: 'tests passed' }],
    critiques: [],
  };
  const rendered = renderRecall('all', input);
  assert.ok(rendered.includes('Session goal:'));
  assert.ok(rendered.includes('No reminders are stored for this session.'));
  assert.ok(rendered.includes('Solved items:'));
  assert.ok(rendered.includes('No critiques are stored for this session.'));
});

test('renderRecall returns an actionable listing for an unsupported section', () => {
  const rendered = renderRecall('tasks', { reminders: [], solvedItems: [], critiques: [] });
  assert.equal(rendered, 'Unknown section "tasks" — supported values: goal, reminders, solved, critiques, all.');
});

// ── Memo integration (FR-036) ──

test('buildMemo renders the Agent reports section between solved items and critiques', () => {
  const memo = buildMemo({
    goal: 'ship the supervisor',
    solvedItems: [{ tool: 'bash', outcome: 'tests passed' }],
    agentReports: [report('blocker', 'the auth service is down')],
    critiques: [{ text: 'arithmetic slipped', severity: 'minor', delivered: true }],
  });
  assert.ok(memo);
  assert.ok(memo.includes('Agent reports:'));
  assert.ok(memo.includes('- [blocker] the auth service is down'));
  assert.ok(memo.indexOf('Recently solved:') < memo.indexOf('Agent reports:'));
  assert.ok(memo.indexOf('Agent reports:') < memo.indexOf('Recent critiques:'));
});

test('buildMemo omits the Agent reports section when no reports are stored', () => {
  const memo = buildMemo({ goal: 'ship the supervisor', solvedItems: [], critiques: [] });
  assert.ok(memo);
  assert.ok(!memo.includes('Agent reports:'));
});

test('buildMemo bounds the Agent reports section by maxReports', () => {
  const memo = buildMemo(
    {
      goal: 'ship the supervisor',
      solvedItems: [],
      critiques: [],
      agentReports: [report('note', 'first'), report('note', 'second'), report('note', 'third')],
    },
    { maxSolvedItems: 5, maxCritiques: 3, maxReminders: 10, maxReports: 2 }
  );
  assert.ok(memo);
  assert.ok(!memo.includes('- [note] first'));
  assert.ok(memo.includes('- [note] second'));
  assert.ok(memo.includes('- [note] third'));
});

// ── Tool layer: report (FR-034, FR-035) ──

test('report stores a report and echoes it back', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.report.execute(
      { kind: 'blocker', text: '  the auth service is down  ' },
      toolContext('console-report-basic')
    );
    // FR-034: the echo is the in-conversation delivery that survives
    // gateway memo drops (design D7).
    assert.equal(
      result,
      'blocker report recorded: the auth service is down. It appears in the supervisor memo for the engineer.'
    );
    const state = sessionState.get('console-report-basic');
    assert.equal(state.agentReports.length, 1);
    assert.equal(state.agentReports[0].kind, 'blocker');
    assert.equal(state.agentReports[0].text, 'the auth service is down');
    assert.ok(!Number.isNaN(Date.parse(state.agentReports[0].addedAt)));
  });
});

test('report rejects an unknown kind without storing anything', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.report.execute(
      { kind: 'incident', text: 'something happened' },
      toolContext('console-report-kind')
    );
    assert.equal(result, 'Unknown report kind "incident" — supported kinds: blocker, deviation, outcome, note.');
    assert.equal(sessionState.peek('console-report-kind'), undefined);
  });
});

test('report rejects whitespace-only text without creating session state', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.report.execute(
      { kind: 'note', text: '   ' },
      toolContext('console-report-empty')
    );
    assert.ok(result.includes('state the event to report'));
    assert.equal(sessionState.peek('console-report-empty'), undefined);
  });
});

test('report truncates over-length text and notes it in the result', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.report.execute(
      { kind: 'note', text: 'a'.repeat(2500) },
      toolContext('console-report-truncate')
    );
    assert.ok(result.includes('(truncated to 2000 characters)'));
    const state = sessionState.get('console-report-truncate');
    assert.equal(state.agentReports[0].text.length, MAX_REPORT_TEXT);
  });
});

test('report bounds stored reports to the configured maxReports', async () => {
  await withCleanConsoleEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_REPORTS = '2';
    const hooks = await plugin.server(silentPluginInput());
    const context = toolContext('console-report-bound');
    await hooks.tool!.report.execute({ kind: 'note', text: 'first' }, context);
    await hooks.tool!.report.execute({ kind: 'note', text: 'second' }, context);
    await hooks.tool!.report.execute({ kind: 'note', text: 'third' }, context);
    // FR-035: storage keeps the most recent two at append time.
    const state = sessionState.get('console-report-bound');
    assert.deepEqual(
      state.agentReports.map((entry) => entry.text),
      ['second', 'third']
    );
    // FR-036 (render side): the memo shows the same bounded list.
    const messages = await dispatchMemoTransform(hooks, 'console-report-bound');
    const memo = messageText(messages[1]);
    assert.ok(memo.includes('- [note] second'));
    assert.ok(memo.includes('- [note] third'));
    assert.ok(!memo.includes('- [note] first'));
  });
});

test('the memo transform injects stored reports as a memo message', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'console-report-memo';
    await hooks.tool!.report.execute({ kind: 'deviation', text: 'skipped the flaky test' }, toolContext(sessionID));
    const messages = await dispatchMemoTransform(hooks, sessionID);
    // FR-036: reports ride the memo, so they survive context compaction.
    assert.equal(messages.length, 2);
    const memo = messageText(messages[1]);
    assert.ok(memo.includes('Agent reports:'));
    assert.ok(memo.includes('- [deviation] skipped the flaky test'));
  });
});

// ── Tool layer: recall (FR-033, design D3 retention) ──

test('recall returns the full retained solved items beyond the memo render cap', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'console-recall-retention';
    for (const step of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']) {
      await dispatchToolAfter(hooks, sessionID, 'bash', { title: 't', output: `step ${step} done`, metadata: {} });
    }
    // Design D3: storage retains far more than the memo renders...
    const state = sessionState.get(sessionID);
    assert.equal(state.solvedItems.length, 8);
    assert.equal(SOLVED_RETENTION_CAP, 50);
    // ...the memo still shows only the five most recent...
    const messages = await dispatchMemoTransform(hooks, sessionID);
    const memo = messageText(messages[1]);
    assert.ok(memo.includes('step eight done'));
    assert.ok(!memo.includes('step one done'));
    // ...and recall reaches the entries the memo no longer shows.
    const result = await hooks.tool!.recall.execute({ what: 'solved' }, toolContext(sessionID));
    assert.ok(result.includes('step one done'));
    assert.ok(result.includes('step eight done'));
  });
});

test('recall lists the supported sections for an unknown what', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.recall.execute({ what: 'tasks' }, toolContext('console-recall-unknown'));
    assert.equal(result, 'Unknown section "tasks" — supported values: goal, reminders, solved, critiques, all.');
  });
});

// ── Tool layer: request_audit (FR-037..FR-039) ──

test('request_audit records a passing focus in the verified trace', async () => {
  await withCleanConsoleEnv(async () => {
    const { input, calls } = auditInput(PASSED_AUDIT);
    const hooks = await plugin.server(input);
    const result = await hooks.tool!.request_audit.execute(
      { focus: 'the rate = 24 * 15 = 360' },
      toolContext('console-audit-pass')
    );
    // FR-037: passed focus joins the verified trace in stripped form.
    assert.equal(result, 'Audit passed — the focus is recorded in the verified trace:\nthe rate = 24 * 15 = 360');
    assert.deepEqual(sessionState.get('console-audit-pass').verifiedSteps, [{ text: 'the rate = 24 * 15 = 360', passed: true }]);
    // The audit ran through one side session, cleaned up after itself.
    assert.equal(calls.create.length, 1);
    assert.equal(calls.delete.length, 1);
  });
});

test('request_audit names the assurance level when no auditor model resolved', async () => {
  await withCleanConsoleEnv(async () => {
    // Review round 5: no model anywhere — env knobs are cleared, the
    // config files are absent, and the host config serves none — so
    // deterministic invariants are the whole audit and the result
    // must not overclaim LLM review.
    const input = {
      client: {
        session: {
          create: async () => ({ data: { id: 'side-1' } }),
          prompt: async () => ({ data: { info: {}, parts: [{ type: 'text', text: PASSED_AUDIT }] } }),
          promptAsync: async () => ({}),
          abort: async () => ({}),
          delete: async () => ({}),
        },
        app: { log: async () => ({}) },
        config: { get: async () => ({ data: {} }) },
      },
      directory: '/tmp/supervisor-test',
    };
    const hooks = await plugin.server(input as unknown as PluginInput);
    const result = await hooks.tool!.request_audit.execute(
      { focus: 'the rate = 24 * 15 = 360' },
      toolContext('console-audit-invariants')
    );
    assert.equal(
      result,
      'Audit passed on deterministic invariants only (no auditor model configured) — the focus is recorded in the verified trace:\nthe rate = 24 * 15 = 360'
    );
    assert.deepEqual(sessionState.get('console-audit-invariants').verifiedSteps, [{ text: 'the rate = 24 * 15 = 360', passed: true }]);
  });
});

test('request_audit names the assurance level when the audit infrastructure fails open', async () => {
  await withCleanConsoleEnv(async () => {
    // Review round 5: the derived model resolves, but the side-session
    // prompt rejects — the audit fails open (FR-005) and the result
    // must say so instead of a plain "Audit passed".
    const input = {
      client: {
        session: {
          create: async () => ({ data: { id: 'side-1' } }),
          prompt: async () => {
            throw new Error('side session unavailable');
          },
          promptAsync: async () => ({}),
          abort: async () => ({}),
          delete: async () => ({}),
        },
        ...silentClientSurface,
      },
      directory: '/tmp/supervisor-test',
    };
    const hooks = await plugin.server(input as unknown as PluginInput);
    const result = await hooks.tool!.request_audit.execute(
      { focus: 'the rate = 24 * 15 = 360' },
      toolContext('console-audit-fail-open')
    );
    assert.equal(
      result,
      'Audit infrastructure failed open — the focus is recorded as passed without LLM review:\nthe rate = 24 * 15 = 360'
    );
    assert.deepEqual(sessionState.get('console-audit-fail-open').verifiedSteps, [{ text: 'the rate = 24 * 15 = 360', passed: true }]);
  });
});

test('request_audit returns the critique in the result without steering on failure', async () => {
  await withCleanConsoleEnv(async () => {
    const { input, calls } = auditInput(PASSED_AUDIT);
    const hooks = await plugin.server(input);
    // A deterministic arithmetic failure (FR-003): the invariant catches
    // it before any model call, so no side session is created.
    const result = await hooks.tool!.request_audit.execute(
      { focus: 'a = 1 + 1 = 3' },
      toolContext('console-audit-fail')
    );
    assert.ok(result.startsWith('Audit failed ('));
    assert.ok(result.includes('Arithmetic error'));
    // FR-038: no steer, no interrupt, no regeneration-budget use.
    assert.equal(calls.promptAsync.length, 0);
    assert.equal(calls.abort.length, 0);
    const state = sessionState.get('console-audit-fail');
    assert.equal(state.critiqueCount, 0);
    assert.equal(state.critiqueLog.length, 1);
    assert.equal(state.critiqueLog[0].delivered, true);
    // The failed focus never joins the verified trace.
    assert.equal(state.verifiedSteps.length, 0);
  });
});

test('request_audit rejects a whitespace-only focus without consuming the bound', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.request_audit.execute({ focus: '   ' }, toolContext('console-audit-empty'));
    assert.equal(result, 'Audit focus is empty after trimming — state the claim or step to check.');
    assert.equal(sessionState.peek('console-audit-empty'), undefined);
  });
});

test('request_audit rejects a focus that strips to no formal content', async () => {
  await withCleanConsoleEnv(async () => {
    const { input, calls } = auditInput(PASSED_AUDIT);
    const hooks = await plugin.server(input);
    const result = await hooks.tool!.request_audit.execute(
      { focus: 'I think this is probably the right approach going forward.' },
      toolContext('console-audit-narrative')
    );
    assert.equal(
      result,
      'Audit focus contained no formal content after narrative stripping — restate the claim with the code, math, or commands it depends on.'
    );
    // No model call, and the per-session bound is untouched.
    assert.equal(calls.create.length, 0);
    assert.equal(sessionState.get('console-audit-narrative').onDemandAuditCount, 0);
  });
});

test('request_audit is bounded per session', async () => {
  await withCleanConsoleEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MAX_ON_DEMAND_AUDITS = '1';
    const { input, calls } = auditInput(PASSED_AUDIT);
    const hooks = await plugin.server(input);
    const context = toolContext('console-audit-bound');
    const first = await hooks.tool!.request_audit.execute({ focus: 'the rate = 24 * 15 = 360' }, context);
    assert.ok(first.startsWith('Audit passed'));
    // FR-039: the second request names the bound; the automatic loop stays.
    const second = await hooks.tool!.request_audit.execute({ focus: 'b = 2 + 2 = 4' }, context);
    assert.equal(
      second,
      'On-demand audit limit reached (1 per session) — no audit ran. The automatic audit loop remains in effect.'
    );
    // Only the first request reached the model.
    assert.equal(calls.create.length, 1);
  });
});

test('failed on-demand critiques retain only the most recent CRITIQUE_RETENTION_CAP entries', async () => {
  await withCleanConsoleEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MAX_ON_DEMAND_AUDITS = '40';
    const hooks = await plugin.server(silentPluginInput());
    const context = toolContext('console-audit-retention');
    // 32 deterministic failures — no model calls, each appends the log.
    for (let i = 0; i < 32; i += 1) {
      await hooks.tool!.request_audit.execute({ focus: `a${i} = 1 + 1 = 3` }, context);
    }
    // Design D3: the log keeps the most recent 30, dropping the oldest two.
    const state = sessionState.get('console-audit-retention');
    assert.equal(CRITIQUE_RETENTION_CAP, 30);
    assert.equal(state.critiqueLog.length, 30);
    assert.equal(state.critiqueLog[0].delivered, true);
  });
});

// ── FR-042: self-reported text never enters the audit prompt ──

test('stored report text never enters the audit prompt', async () => {
  await withCleanConsoleEnv(async () => {
    const { input, calls } = auditInput(PASSED_AUDIT);
    const hooks = await plugin.server(input);
    const context = toolContext('console-trust-boundary');
    await hooks.tool!.report.execute({ kind: 'note', text: 'CANARY-REPORT-TEXT-xyzzy' }, context);
    await hooks.tool!.request_audit.execute({ focus: 'the rate = 24 * 15 = 360' }, context);
    // FR-042: the audit prompt carries the goal and focus, never reports.
    assert.equal(calls.prompt.length, 1);
    const promptText = JSON.stringify(calls.prompt[0]);
    assert.ok(promptText.includes('the rate = 24 * 15 = 360'));
    assert.ok(!promptText.includes('CANARY-REPORT-TEXT-xyzzy'));
  });
});

// ── FR-040: side sessions get an inert result, never state ──

test('console tools return an inert result in auditor side sessions', async () => {
  await withCleanConsoleEnv(async () => {
    // A parked audit keeps side session 'auditor-side-live' registered for
    // self-suppression while the console tools are exercised against it —
    // exactly the window in which a side session could see the tools.
    const parkedResolvers: Array<(response: unknown) => void> = [];
    const calls = { create: [] as unknown[], delete: [] as unknown[] };
    const input = {
      client: {
        session: {
          create: async (options: unknown) => {
            calls.create.push(options);
            return { data: { id: 'auditor-side-live' } };
          },
          prompt: () =>
            new Promise((resolve) => {
              parkedResolvers.push(resolve);
            }),
          promptAsync: async () => ({}),
          abort: async () => ({}),
          delete: async (options: unknown) => {
            calls.delete.push(options);
            return {};
          },
        },
        ...silentClientSurface,
      },
      directory: '/tmp/supervisor-test',
    };
    const hooks = await plugin.server(input as unknown as PluginInput);

    const supervisedID = 'supervised-console-inert';
    const auditRun = dispatchPart(hooks, completedReasoningPart({ sessionID: supervisedID }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.create.length, 1);
    assert.equal(parkedResolvers.length, 1);

    const context = toolContext('auditor-side-live');
    const recall = await hooks.tool!.recall.execute({ what: 'all' }, context);
    assert.equal(recall, 'Console tools are not available in supervisor side sessions.');
    const reported = await hooks.tool!.report.execute({ kind: 'note', text: 'quirk' }, context);
    assert.equal(reported, 'Console tools are not available in supervisor side sessions.');
    const audited = await hooks.tool!.request_audit.execute({ focus: 'a = 1 + 1 = 2' }, context);
    assert.equal(audited, 'Console tools are not available in supervisor side sessions.');
    assert.equal(sessionState.peek('auditor-side-live'), undefined);

    // Release the parked audit: it completes normally for the supervised
    // session, and the side session is deleted exactly once.
    parkedResolvers[0]({
      data: {
        info: {},
        parts: [{ type: 'text', text: PASSED_AUDIT }],
      },
    });
    await auditRun;
    assert.equal(sessionState.get(supervisedID).verifiedSteps.length, 1);
    assert.equal(calls.delete.length, 1);
  });
});

// ── FR-041: fail-open bodies on odd payloads ──

test('console tool bodies never throw on odd payloads', async () => {
  await withCleanConsoleEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const context = toolContext('console-odd-payloads');
    // Non-string kind falls to the unknown-kind listing; nothing stores.
    const oddKind = await hooks.tool!.report.execute({ kind: 42, text: 'hi' }, context);
    assert.ok(oddKind.startsWith('Unknown report kind'));
    // Non-string text falls to the whitespace rejection; nothing stores.
    const oddText = await hooks.tool!.report.execute({ kind: 'note', text: 99 }, context);
    assert.ok(oddText.includes('state the event to report'));
    // Absent focus falls to the whitespace rejection.
    const oddFocus = await hooks.tool!.request_audit.execute({}, context);
    assert.ok(oddFocus.includes('Audit focus is empty after trimming'));
    // Non-string what falls back to the documented default (all).
    const oddWhat = await hooks.tool!.recall.execute({ what: false }, context);
    assert.ok(oddWhat.includes('No goal is stored for this session.'));
    const state = sessionState.get('console-odd-payloads');
    assert.equal(state.agentReports.length, 0);
    assert.equal(state.onDemandAuditCount, 0);
  });
});
