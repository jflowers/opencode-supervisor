import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks } from '@opencode-ai/plugin';
import plugin, { logIdentityState, sessionState } from '../index.ts';
import {
  applyGuardLock,
  compileToolGlob,
  matchesToolGlob,
  sanitizeNonGlobalTier,
  traceExemptReason,
  validateAgentOverrides,
} from '../src/agent-overrides.ts';
import { validateSupervisorConfig } from '../src/config-file.ts';
import { verifyToolIntent } from '../src/tool-guard.ts';
import { recordingPluginInput } from './mocks.ts';

// ── Pure rules (FR-073..FR-075) ───────────────────────────────────

test('compileToolGlob anchors, supports * and ?, and escapes regex metacharacters', () => {
  assert.ok(compileToolGlob('dewey_*').test('dewey_store_learning'));
  assert.ok(!compileToolGlob('dewey_*').test('xdewey_search'));
  assert.ok(compileToolGlob('dewey_searc?').test('dewey_search'));
  assert.ok(!compileToolGlob('a.b').test('axb'));
  assert.ok(compileToolGlob('a(b)').test('a(b)'));
  assert.ok(!compileToolGlob('Dewey_*').test('dewey_search'));
  assert.ok(matchesToolGlob('promote', ['dewey_*', 'promote']));
  assert.ok(!matchesToolGlob('edit', ['dewey_*']));
});

test('validateAgentOverrides accepts a narrowing exemption', () => {
  const parsed = validateAgentOverrides({ curator: { traceCheck: { exemptTools: [' dewey_* ', 'read'] } } });
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.overrides, { curator: { traceCheck: { exemptTools: ['dewey_*', 'read'] } } });
});

test('validateAgentOverrides drops a bad entry and keeps the others', () => {
  const parsed = validateAgentOverrides({
    curator: { traceCheck: { exemptTools: ['dewey_*'] } },
    rogue: { blockRewardHacking: false },
    loose: { traceCheck: { exemptTools: ['*'] } },
    shell: { traceCheck: { exemptTools: ['ba?h'] } },
    typo: { traceCheck: { exemptTool: ['x'] } },
    empty: { traceCheck: { exemptTools: [''] } },
    scalar: 'yes',
  });
  assert.deepEqual(Object.keys(parsed.overrides), ['curator']);
  assert.equal(parsed.warnings.length, 6);
  assert.match(parsed.warnings[0]!, /agentOverrides\["rogue"\] dropped: unknown key\(s\) "blockRewardHacking"; overrides only narrow guards/);
  assert.match(parsed.warnings[1]!, /"\*" matches the file-mutating builtin "bash"/);
  assert.match(parsed.warnings[2]!, /"ba\?h" matches the file-mutating builtin "bash"/);
  assert.match(parsed.warnings[3]!, /unknown traceCheck key\(s\) "exemptTool"/);
  assert.match(parsed.warnings[4]!, /must be an array of non-empty tool-name globs/);
  assert.match(parsed.warnings[5]!, /\["scalar"\] dropped: must be an object/);
});

test('validateAgentOverrides rejects a non-object value as a whole', () => {
  assert.deepEqual(validateAgentOverrides(['curator']), {
    overrides: {},
    warnings: ['"agentOverrides" ignored: must be an object keyed by agent name'],
  });
});

test('validateSupervisorConfig keeps the rest of the file when an override entry is bad', () => {
  const parsed = validateSupervisorConfig({
    lockGuards: true,
    agentOverrides: { curator: { traceCheck: { exemptTools: ['*'] } } },
  });
  assert.equal(parsed.error, null);
  assert.equal(parsed.config.lockGuards, true);
  assert.deepEqual(parsed.config.agentOverrides, {});
  assert.equal(parsed.warnings?.length, 1);
});

test('validateSupervisorConfig rejects a non-boolean lockGuards like other toggles', () => {
  assert.equal(validateSupervisorConfig({ lockGuards: 'yes' }).error, '"lockGuards" must be a boolean');
});

test('traceExemptReason matches the exact agent and a granted tool only', () => {
  const overrides = { curator: { traceCheck: { exemptTools: ['dewey_*'] } } };
  assert.match(traceExemptReason('curator', 'dewey_promote', overrides)!, /for agent 'curator' by global agentOverrides/);
  assert.equal(traceExemptReason('Curator', 'dewey_promote', overrides), null);
  assert.equal(traceExemptReason('build', 'dewey_promote', overrides), null);
  assert.equal(traceExemptReason('curator', 'edit', overrides), null);
  assert.equal(traceExemptReason(undefined, 'dewey_promote', overrides), null);
  assert.equal(traceExemptReason('curator', 'dewey_promote', undefined), null);
  assert.equal(traceExemptReason('toString', 'dewey_promote', overrides), null);
});

test('applyGuardLock removes only guard-disabling false values, and only when locked', () => {
  const tier = { blockRewardHacking: false, requireStepReferenceInTools: true, maxRegenerations: 1 };
  assert.deepEqual(applyGuardLock(tier, 'project', false), { config: tier, warnings: [] });
  const locked = applyGuardLock(tier, 'project', true);
  assert.deepEqual(locked.config, { requireStepReferenceInTools: true, maxRegenerations: 1 });
  assert.deepEqual(locked.warnings, [
    'project sets blockRewardHacking: false; ignored because the global config sets lockGuards: true',
  ]);
  assert.equal(tier.blockRewardHacking, false, 'input not mutated');
});

test('sanitizeNonGlobalTier strips agentOverrides and lockGuards and applies the lock', () => {
  const result = sanitizeNonGlobalTier(
    { agentOverrides: {}, lockGuards: false, requireStepReferenceInTools: false, stripMode: 'strict' as const },
    'project supervisor config file',
    true
  );
  assert.deepEqual(result.config, { stripMode: 'strict' });
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0]!, /agentOverrides; ignored — agent overrides are honored only from the global config file/);
  assert.match(result.warnings[1]!, /lockGuards; ignored/);
  assert.match(result.warnings[2]!, /requireStepReferenceInTools: false; ignored/);
});

test('verifyToolIntent: an exempt reason skips only the trace check', () => {
  const trace = ['Edit src/a.ts to export the helper.'];
  const config = { blockRewardHacking: true, requireStepReferenceInTools: true };
  const call = { name: 'dewey_store_learning', arguments: { file: 'docs/corpus/source-17.md' } };
  assert.equal(verifyToolIntent(call, trace, config).blockedCheck, 'trace');
  const exempt = verifyToolIntent(call, trace, config, undefined, undefined, 'exempt for curator');
  assert.deepEqual(exempt, { allowed: true, reason: 'exempt for curator' });
  const hack = verifyToolIntent(
    { name: 'dewey_store_learning', arguments: { flags: '--no-verify' } },
    trace,
    config,
    undefined,
    undefined,
    'exempt for curator'
  );
  assert.equal(hack.blockedCheck, 'reward-hacking');
});

// ── Hook layer (FR-072..FR-075 scenarios) ─────────────────────────

/** Runs `run` with supervisor env knobs cleared and XDG_CONFIG_HOME pointing at a fresh root. */
async function withIsolatedConfig(
  files: { global?: unknown; project?: unknown },
  run: (projectDir: string, xdgRoot: string) => Promise<void>
): Promise<void> {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('OPENCODE_SUPERVISOR_')) delete process.env[name];
  }
  logIdentityState.identityLogged = false;
  logIdentityState.identitySaidNoModel = false;
  const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-project-'));
  process.env.XDG_CONFIG_HOME = xdgRoot;
  if (files.global !== undefined) {
    fs.mkdirSync(path.join(xdgRoot, 'opencode', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(xdgRoot, 'opencode', 'supervisor', 'config.json'), JSON.stringify(files.global));
  }
  if (files.project !== undefined) {
    fs.mkdirSync(path.join(projectDir, '.opencode', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.opencode', 'supervisor', 'config.json'), JSON.stringify(files.project));
  }
  try {
    await run(projectDir, xdgRoot);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
    fs.rmSync(xdgRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

let sessionSeq = 0;

/** A session with a non-empty verified trace that does not name the corpus path. */
async function startSession(hooks: Hooks, agent?: string): Promise<string> {
  const sessionID = `agent-override-session-${++sessionSeq}`;
  await hooks['chat.message']!(
    { sessionID, ...(agent !== undefined ? { agent } : {}) },
    { message: { role: 'user' } as never, parts: [{ type: 'text', text: 'Curate the corpus.' } as never] }
  );
  sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });
  return sessionID;
}

const callTool = (hooks: Hooks, sessionID: string, tool: string, args: Record<string, unknown>) =>
  hooks['tool.execute.before']!({ tool, sessionID, callID: 'call-1' }, { args });

const CURATOR_GRANT = { agentOverrides: { curator: { traceCheck: { exemptTools: ['dewey_*'] } } } };
const CORPUS_ARGS = { file: 'docs/corpus/source-17.md' };

test('FR-072: chat.message records the latest user message agent', async () => {
  await withIsolatedConfig({}, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, 'build');
    assert.equal(sessionState.get(sessionID).agent, 'build');
    await hooks['chat.message']!(
      { sessionID, agent: 'curator' },
      { message: { role: 'user' } as never, parts: [{ type: 'text', text: 'next' } as never] }
    );
    assert.equal(sessionState.get(sessionID).agent, 'curator');
    await hooks.dispose!();
  });
});

test('FR-074: a granted agent passes the trace check on an exempt tool', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, 'curator');
    await assert.doesNotReject(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS));
    await hooks.dispose!();
  });
});

test('FR-074: other agents, unknown agents, and other tools are unchanged', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const build = await startSession(hooks, 'build');
    await assert.rejects(() => callTool(hooks, build, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const unknown = await startSession(hooks);
    await assert.rejects(() => callTool(hooks, unknown, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const curator = await startSession(hooks, 'curator');
    await assert.rejects(
      () => callTool(hooks, curator, 'write', { filePath: 'docs/corpus/source-17.md', content: 'x' }),
      /file-path trace check/
    );
    await hooks.dispose!();
  });
});

test('FR-074: reward-hacking still applies to an exempt call', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, 'curator');
    await assert.rejects(
      () => callTool(hooks, sessionID, 'dewey_store_learning', { flags: '--no-verify' }),
      /reward-hacking check/
    );
    await hooks.dispose!();
  });
});

test('FR-073: project and plugin-options overrides are ignored with a warning', async () => {
  await withIsolatedConfig({ project: CURATOR_GRANT }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input, { config: CURATOR_GRANT } as never);
    const sessionID = await startSession(hooks, 'curator');
    await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const warns = harness.logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
    assert.ok(warns.some((m) => m.includes('project supervisor config file sets agentOverrides; ignored')));
    assert.ok(warns.some((m) => m.includes('plugin options supervisor config sets agentOverrides; ignored')));
    await hooks.dispose!();
  });
});

test('FR-073: a bad global entry warns and does not drop lockGuards', async () => {
  await withIsolatedConfig(
    {
      global: { lockGuards: true, agentOverrides: { curator: { blockRewardHacking: false } } },
      project: { requireStepReferenceInTools: false },
    },
    async (dir) => {
      const harness = recordingPluginInput(dir);
      const hooks = await plugin.server(harness.input);
      const sessionID = await startSession(hooks, 'curator');
      await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
      const warns = harness.logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
      assert.ok(warns.some((m) => m.includes('global supervisor config: agentOverrides["curator"] dropped')));
      assert.ok(warns.some((m) => m.includes('requireStepReferenceInTools: false; ignored because the global config sets lockGuards: true')));
      await hooks.dispose!();
    }
  );
});

test('FR-075: without the lock, project config still disables the trace check', async () => {
  await withIsolatedConfig({ project: { requireStepReferenceInTools: false } }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, 'build');
    await assert.doesNotReject(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS));
    await hooks.dispose!();
  });
});

test('FR-075: with the lock, project config cannot disable either guard', async () => {
  await withIsolatedConfig(
    { global: { lockGuards: true }, project: { requireStepReferenceInTools: false, blockRewardHacking: false } },
    async (dir) => {
      const harness = recordingPluginInput(dir);
      const hooks = await plugin.server(harness.input);
      const sessionID = await startSession(hooks, 'build');
      await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
      await assert.rejects(() => callTool(hooks, sessionID, 'bash', { command: 'git commit --no-verify' }), /reward-hacking/);
      const info = harness.logEntries.find((e) => e.level === 'info' && e.message.includes('lockGuards='));
      assert.match(info?.message ?? '', /blockRewardHacking=true, stepReference=true, lockGuards=true/);
      await hooks.dispose!();
    }
  );
});

test('FR-075: the environment stays authoritative under the lock', async () => {
  await withIsolatedConfig({ global: { lockGuards: true } }, async (dir) => {
    process.env.OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS = 'false';
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, 'build');
    await assert.doesNotReject(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS));
    await hooks.dispose!();
  });
});

test('FR-075: lockGuards outside the global file is ignored with a warning', async () => {
  await withIsolatedConfig({ project: { lockGuards: true } }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    await startSession(hooks, 'build');
    const sessionID = await startSession(hooks, 'build');
    await callTool(hooks, sessionID, 'read', { filePath: 'src/a.ts' }).catch(() => undefined);
    assert.ok(
      harness.logEntries.some((e) => e.level === 'warn' && e.message.includes('project supervisor config file sets lockGuards; ignored'))
    );
    const info = harness.logEntries.find((e) => e.level === 'info' && e.message.includes('lockGuards='));
    assert.match(info?.message ?? '', /lockGuards=false/);
    await hooks.dispose!();
  });
});

test('the identity line names the agents carrying global overrides', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks, 'curator');
    await callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS);
    const info = harness.logEntries.find((e) => e.level === 'info' && e.message.includes('lockGuards='));
    assert.match(info?.message ?? '', /agentOverrides: curator/);
    await hooks.dispose!();
  });
});
