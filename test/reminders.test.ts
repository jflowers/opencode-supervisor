import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import plugin, { sessionState } from '../index.ts';
import {
  addReminder,
  clearReminder,
  MAX_REMINDER_TEXT_LENGTH,
  prepareReminderText,
  renderReminders,
  type Reminder,
} from '../src/reminders.ts';
import { buildMemo } from '../src/memo.ts';
import { completedReasoningPart, silentClientSurface, silentPluginInput, toolContext, withCleanSupervisorEnv } from './mocks.ts';

/** A stored reminder with a fixed timestamp — the module never touches the clock. */
function reminder(id: string, text: string): Reminder {
  return { id, text, addedAt: '2026-10-25T00:00:00.000Z' };
}

/** Event-hook input shape, for casting deliberately undeclared event payloads. */
type EventHookInput = Parameters<NonNullable<Hooks['event']>>[0];

/** Dispatches one message.part.updated event through the hook. */
function dispatchPart(hooks: Hooks, part: unknown): Promise<void> {
  return hooks.event!({ event: { type: 'message.part.updated', properties: { part } } } as unknown as EventHookInput);
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

// ── Pure module: prepareReminderText (FR-025) ──

test('prepareReminderText trims and accepts ordinary text', () => {
  const prepared = prepareReminderText('  use bash 4.5 for the test suite  ');
  assert.deepEqual(prepared, { ok: true, text: 'use bash 4.5 for the test suite', truncated: false });
});

test('prepareReminderText rejects whitespace-only text with an actionable error', () => {
  const prepared = prepareReminderText('   \n\t  ');
  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.ok(prepared.error.includes('state the fact to remember'));
  }
});

test('prepareReminderText truncates over-length text at the fixed ceiling', () => {
  assert.equal(MAX_REMINDER_TEXT_LENGTH, 2000);
  const prepared = prepareReminderText('a'.repeat(2500));
  assert.deepEqual(prepared, { ok: true, text: 'a'.repeat(2000), truncated: true });
});

// ── Pure module: addReminder / clearReminder (FR-020, FR-021, FR-023) ──

test('addReminder appends and bounds storage to the most recent entries', () => {
  const start = [reminder('r1', 'first')];
  const two = addReminder(start, reminder('r2', 'second'), 2);
  assert.deepEqual(two.map((entry) => entry.id), ['r1', 'r2']);
  const three = addReminder(two, reminder('r3', 'third'), 2);
  assert.deepEqual(three.map((entry) => entry.id), ['r2', 'r3']);
  // Pure: the inputs are untouched.
  assert.equal(start.length, 1);
  assert.equal(two.length, 2);
});

test('addReminder stores nothing when the cap is zero', () => {
  const next = addReminder([reminder('r1', 'first')], reminder('r2', 'second'), 0);
  assert.deepEqual(next, []);
});

test('clearReminder removes by id without renumbering', () => {
  const start = [reminder('r1', 'first'), reminder('r2', 'second'), reminder('r3', 'third')];
  const next = clearReminder(start, 'r2');
  assert.deepEqual(next?.map((entry) => entry.id), ['r1', 'r3']);
  assert.equal(start.length, 3); // pure: input untouched
  assert.equal(clearReminder(start, 'r9'), null);
});

// ── Pure module: renderReminders (FR-022) ──

test('renderReminders lists reminders with their ids, most recent last', () => {
  const section = renderReminders([reminder('r1', 'use bash 4.5'), reminder('r2', 'do not retry the flaky import')], 10);
  assert.equal(section, 'Reminders:\n- r1: use bash 4.5\n- r2: do not retry the flaky import');
});

test('renderReminders returns null when empty or capped to zero', () => {
  assert.equal(renderReminders([], 10), null);
  assert.equal(renderReminders([reminder('r1', 'first')], 0), null);
});

test('renderReminders keeps the most recent reminders within the cap', () => {
  const section = renderReminders(
    [reminder('r1', 'first'), reminder('r2', 'second'), reminder('r3', 'third')],
    2
  );
  assert.equal(section, 'Reminders:\n- r2: second\n- r3: third');
});

// ── Memo integration (FR-022, FR-023) ──

test('buildMemo renders the Reminders section between the goal and solved items', () => {
  const memo = buildMemo({
    goal: 'ship the supervisor',
    reminders: [reminder('r1', 'use bash 4.5 for the test suite')],
    solvedItems: [{ tool: 'bash', outcome: 'tests passed' }],
    critiques: [{ text: 'arithmetic slipped', severity: 'minor', delivered: true }],
  });
  assert.ok(memo);
  assert.ok(memo.includes('- r1: use bash 4.5 for the test suite'));
  assert.ok(memo.indexOf('Session goal:') < memo.indexOf('Reminders:'));
  assert.ok(memo.indexOf('Reminders:') < memo.indexOf('Recently solved:'));
  assert.ok(memo.indexOf('Recently solved:') < memo.indexOf('Recent critiques:'));
});

test('buildMemo omits the Reminders section when no reminders are stored', () => {
  const memo = buildMemo({ goal: 'ship the supervisor', solvedItems: [], critiques: [] });
  assert.ok(memo);
  assert.ok(!memo.includes('Reminders:'));
  assert.equal(buildMemo({ reminders: [], solvedItems: [], critiques: [] }), null);
});

test('buildMemo bounds the Reminders section by maxReminders', () => {
  const memo = buildMemo(
    {
      goal: 'ship the supervisor',
      reminders: [reminder('r1', 'first'), reminder('r2', 'second'), reminder('r3', 'third')],
      solvedItems: [],
      critiques: [],
    },
    { maxSolvedItems: 5, maxCritiques: 3, maxReminders: 2, maxReports: 5 }
  );
  assert.ok(memo);
  assert.ok(!memo.includes('- r1: first'));
  assert.ok(memo.includes('- r2: second'));
  assert.ok(memo.includes('- r3: third'));
});

// ── Tool layer: remind_me / forget_reminder (FR-020, FR-021, FR-025) ──

test('remind_me stores a reminder and echoes it with its id', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.remind_me.execute(
      { text: '  use bash 4.5 for the test suite  ' },
      toolContext('reminders-tool-basic')
    );
    // FR-020: the echo is the in-conversation delivery that survives
    // gateway memo drops (design D7).
    assert.equal(
      result,
      'Reminder r1 stored: use bash 4.5 for the test suite. ' +
        'It reappears in the supervisor memo each turn; clear it with forget_reminder r1 when it no longer applies.'
    );
    const state = sessionState.get('reminders-tool-basic');
    assert.equal(state.reminders.length, 1);
    assert.equal(state.reminders[0].id, 'r1');
    assert.equal(state.reminders[0].text, 'use bash 4.5 for the test suite');
    assert.ok(!Number.isNaN(Date.parse(state.reminders[0].addedAt)));
  });
});

test('remind_me assigns sequential ids that are never recycled', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const context = toolContext('reminders-tool-sequence');
    await hooks.tool!.remind_me.execute({ text: 'first' }, context);
    await hooks.tool!.remind_me.execute({ text: 'second' }, context);
    await hooks.tool!.forget_reminder.execute({ id: 'r1' }, context);
    const result = await hooks.tool!.remind_me.execute({ text: 'third' }, context);
    // D3: forgetting r1 does not recycle the id.
    assert.ok(result.startsWith('Reminder r3 stored: third.'));
  });
});

test('remind_me rejects whitespace-only text without creating session state', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.remind_me.execute({ text: '   ' }, toolContext('reminders-tool-empty'));
    assert.ok(result.includes('state the fact to remember'));
    assert.equal(sessionState.peek('reminders-tool-empty'), undefined);
  });
});

test('remind_me truncates over-length text and notes it in the result', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.remind_me.execute(
      { text: 'a'.repeat(2500) },
      toolContext('reminders-tool-truncate')
    );
    assert.ok(result.includes(`(truncated to ${MAX_REMINDER_TEXT_LENGTH} characters)`));
    const state = sessionState.get('reminders-tool-truncate');
    assert.equal(state.reminders[0].text.length, MAX_REMINDER_TEXT_LENGTH);
  });
});

test('remind_me says reminders are disabled and consumes no id when maxReminders is 0 (FR-077)', async () => {
  await withCleanSupervisorEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS = '0';
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.remind_me.execute({ text: 'use bun' }, toolContext('reminders-tool-disabled'));
    assert.equal(result, 'Reminders are disabled (maxReminders is 0) — nothing was stored.');
    assert.ok(!result.includes('memo'));
    assert.equal(sessionState.peek('reminders-tool-disabled'), undefined);
    // Re-enabled, the first stored reminder still gets r1: no id was burned.
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS = '5';
    const stored = await hooks.tool!.remind_me.execute({ text: 'use bun' }, toolContext('reminders-tool-disabled'));
    assert.ok(stored.startsWith('Reminder r1 stored'));
  });
});

test('remind_me bounds stored reminders to the configured maxReminders', async () => {
  await withCleanSupervisorEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS = '2';
    const hooks = await plugin.server(silentPluginInput());
    const context = toolContext('reminders-tool-bound');
    await hooks.tool!.remind_me.execute({ text: 'first' }, context);
    await hooks.tool!.remind_me.execute({ text: 'second' }, context);
    await hooks.tool!.remind_me.execute({ text: 'third' }, context);
    // FR-023: storage keeps the most recent two at append time.
    const state = sessionState.get('reminders-tool-bound');
    assert.deepEqual(
      state.reminders.map((entry) => entry.id),
      ['r2', 'r3']
    );
  });
});

test('forget_reminder clears a stored reminder', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const context = toolContext('reminders-tool-forget');
    await hooks.tool!.remind_me.execute({ text: 'use bun, not node' }, context);
    const result = await hooks.tool!.forget_reminder.execute({ id: 'r1' }, context);
    assert.equal(result, 'Reminder r1 cleared.');
    assert.equal(sessionState.get('reminders-tool-forget').reminders.length, 0);
  });
});

test('forget_reminder lists current ids for an unknown id', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const context = toolContext('reminders-tool-unknown');
    await hooks.tool!.remind_me.execute({ text: 'first' }, context);
    await hooks.tool!.remind_me.execute({ text: 'second' }, context);
    const result = await hooks.tool!.forget_reminder.execute({ id: 'r9' }, context);
    // FR-021: actionable — the caller can re-issue against a real id.
    assert.equal(result, 'No reminder matches "r9" — current reminders: r1, r2.');
  });
});

test('forget_reminder reports when the session has no reminders', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const result = await hooks.tool!.forget_reminder.execute({ id: 'r1' }, toolContext('reminders-tool-none'));
    assert.equal(result, 'No reminder matches "r1" — the session has no reminders.');
  });
});

test('the memo transform injects stored reminders as a memo message', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'reminders-memo-session';
    await hooks.tool!.remind_me.execute({ text: 'use bash 4.5 for the test suite' }, toolContext(sessionID));
    const messages = await dispatchMemoTransform(hooks, sessionID);
    // FR-022: reminders ride the memo, so they survive context compaction.
    assert.equal(messages.length, 2);
    const memo = messageText(messages[1]);
    assert.ok(memo.includes('Reminders:'));
    assert.ok(memo.includes('- r1: use bash 4.5 for the test suite'));
  });
});

// ── FR-024: side sessions get an inert result, never state ──

test('reminder tools return an inert result in auditor side sessions', async () => {
  await withCleanSupervisorEnv(async () => {
    // A parked audit keeps side session 'auditor-side-live' registered for
    // self-suppression while the reminder tools are exercised against it —
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

    const supervisedID = 'supervised-reminder-inert';
    const auditRun = dispatchPart(hooks, completedReasoningPart({ sessionID: supervisedID }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.create.length, 1);
    assert.equal(parkedResolvers.length, 1);

    const context = toolContext('auditor-side-live');
    const remind = await hooks.tool!.remind_me.execute({ text: 'quirk' }, context);
    assert.equal(remind, 'Reminder tools are not available in supervisor side sessions.');
    const forget = await hooks.tool!.forget_reminder.execute({ id: 'r1' }, context);
    assert.equal(forget, 'Reminder tools are not available in supervisor side sessions.');
    assert.equal(sessionState.peek('auditor-side-live'), undefined);

    // Release the parked audit: it completes normally for the supervised
    // session, and the side session is deleted exactly once.
    parkedResolvers[0]({
      data: {
        info: {},
        parts: [{ type: 'text', text: '{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}' }],
      },
    });
    await auditRun;
    assert.equal(sessionState.get(supervisedID).verifiedSteps.length, 1);
    assert.equal(calls.delete.length, 1);
  });
});
