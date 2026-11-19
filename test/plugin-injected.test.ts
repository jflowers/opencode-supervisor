import test from 'node:test';
import assert from 'node:assert/strict';
import {
  injectedArgsForSession,
  MAX_INJECTED_VALUE_CHARS,
  renderInjectedArgs,
} from '../src/plugin-injected.ts';
import { PLUGIN_INJECTED_ARGS_NOTE, runPeerAudit, type AuditConfig, type InvokeModel } from '../src/auditor.ts';

const HARNESS_KEY = Symbol.for('opencode-research-harness.shared-state');

const harnessStore = (entries: [string, unknown][]): Record<symbol, unknown> => ({
  [HARNESS_KEY]: { loadsByDirectory: new Map(), injectedArgs: new Map(entries) },
});

const auditConfig: AuditConfig = {
  auditorModel: 'mock/auditor-model',
  stripMode: 'code_and_math',
  maxRegenerations: 2,
  blockRewardHacking: true,
  requireStepReferenceInTools: true,
};

test('injectedArgsForSession reads the harness map for one session, oldest first (FR-106)', () => {
  const store = harnessStore([
    ['c1', { sessionID: 's1', tool: 'note_save', args: { tags: ['topic:wirecheck'] } }],
    ['c2', { sessionID: 's2', tool: 'grep', args: { path: '/other' } }],
    ['c3', { sessionID: 's1', tool: 'grep', args: { path: '/p/topics/wirecheck' } }],
  ]);
  const records = injectedArgsForSession('s1', 12, store);
  assert.deepEqual(
    records.map((r) => [r.callID, r.tool, r.plugin]),
    [
      ['c1', 'note_save', 'opencode-research-harness'],
      ['c3', 'grep', 'opencode-research-harness'],
    ]
  );
  // The most recent records win when bounded.
  assert.deepEqual(injectedArgsForSession('s1', 1, store).map((r) => r.callID), ['c3']);
});

test('injectedArgsForSession treats a missing or malformed producer state as nothing injected', () => {
  assert.deepEqual(injectedArgsForSession('s1', 12, {}), []);
  assert.deepEqual(injectedArgsForSession('s1', 12, { [HARNESS_KEY]: { injectedArgs: [] } }), []);
  const store = harnessStore([
    ['c1', null],
    ['c2', { sessionID: 's1', tool: 3, args: {} }],
    ['c3', { sessionID: 's1', tool: 'grep', args: 'path' }],
  ]);
  assert.deepEqual(injectedArgsForSession('s1', 12, store), []);
});

test('renderInjectedArgs names tool, call, plugin, and bounded values', () => {
  assert.equal(renderInjectedArgs([]), undefined);
  const text = renderInjectedArgs([
    { plugin: 'p', callID: 'c1', sessionID: 's1', tool: 'dewey_store_learning', args: { tag: 'wirecheck' } },
    { plugin: 'p', callID: 'c2', sessionID: 's1', tool: 'note_save', args: { tags: ['topic:wirecheck'] } },
    { plugin: 'p', callID: 'c3', sessionID: 's1', tool: 'grep', args: { path: 'x'.repeat(1000) } },
  ])!;
  const lines = text.split('\n');
  assert.equal(lines[0], '- dewey_store_learning (call c1, by p): tag="wirecheck"');
  assert.equal(lines[1], '- note_save (call c2, by p): tags=["topic:wirecheck"]');
  assert.ok(lines[2].length < MAX_INJECTED_VALUE_CHARS + 60, lines[2]);
  assert.ok(lines[2].endsWith('…'));
});

test('runPeerAudit adds the plugin-injected section only when there is one (FR-106)', async () => {
  const prompts: string[] = [];
  const invokeModel: InvokeModel = async (prompt) => {
    prompts.push(prompt);
    return '{"passed":true,"failedStep":null,"severity":null,"critique":"ok"}';
  };
  await runPeerAudit(['x = 1 + 1 = 2'], auditConfig, invokeModel, 'goal');
  await runPeerAudit(['x = 1 + 1 = 2'], auditConfig, invokeModel, 'goal', undefined, '- grep (call c1, by p): path="/p"');
  assert.ok(!prompts[0].includes('Plugin-injected'));
  assert.ok(prompts[1].includes(PLUGIN_INJECTED_ARGS_NOTE));
  assert.ok(prompts[1].includes('- grep (call c1, by p): path="/p"'));
  // The section sits before the steps, so the steps stay last.
  assert.ok(prompts[1].indexOf('Plugin-injected') < prompts[1].indexOf('Reasoning steps to audit:'));
});
