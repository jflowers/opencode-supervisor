import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import plugin, { configPathState, logIdentityState, sessionState } from '../index.ts';
import {
  MAX_PROFILE_ANCESTRY,
  MAX_PROFILES,
  applicableProfiles,
  applyGuardLock,
  compileToolGlob,
  matchesToolGlob,
  normalizeCommand,
  profileMatchesContext,
  sanitizeNonGlobalTier,
  toolMayBeExempt,
  traceExemption,
  validateProfiles,
  type GuardProfile,
} from '../src/guard-profiles.ts';
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

test('normalizeCommand trims and drops leading slashes', () => {
  assert.equal(normalizeCommand(' /dewey-distill '), 'dewey-distill');
  assert.equal(normalizeCommand('uf.fix-ci'), 'uf.fix-ci');
  assert.equal(normalizeCommand('/'), '');
});

test('validateProfiles accepts agent, command, and combined matches', () => {
  const parsed = validateProfiles([
    { name: 'distill', match: { command: '/dewey-distill' }, traceCheck: { exemptTools: [' dewey_* ', 'read'] } },
    { match: { agent: 'curator' }, traceCheck: { exemptTools: ['dewey_*'] } },
    { match: { agent: 'autonomy', command: 'uf.review-pr' }, traceCheck: { exemptTools: ['gh_*'] } },
  ]);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.profiles, [
    { name: 'distill', match: { command: 'dewey-distill' }, traceCheck: { exemptTools: ['dewey_*', 'read'] } },
    { name: 'profiles[1]', match: { agent: 'curator' }, traceCheck: { exemptTools: ['dewey_*'] } },
    { name: 'profiles[2]', match: { agent: 'autonomy', command: 'uf.review-pr' }, traceCheck: { exemptTools: ['gh_*'] } },
  ]);
});

test('validateProfiles drops a bad profile and keeps the others', () => {
  const parsed = validateProfiles([
    { match: { agent: 'curator' }, traceCheck: { exemptTools: ['dewey_*'] } },
    { name: 'rogue', match: { agent: 'curator' }, blockRewardHacking: false, traceCheck: { exemptTools: ['x'] } },
    { match: { agent: 'a' }, traceCheck: { exemptTools: ['*'] } },
    { match: { agent: 'a' }, traceCheck: { exemptTools: ['ba?h'] } },
    { match: { agent: 'a' }, traceCheck: { exemptTool: ['x'] } },
    { match: { agent: 'a' }, traceCheck: { exemptTools: [] } },
    { match: {}, traceCheck: { exemptTools: ['x'] } },
    { match: { repo: 'x' }, traceCheck: { exemptTools: ['x'] } },
    { match: { command: '/' }, traceCheck: { exemptTools: ['x'] } },
    { match: { agent: 'a' } },
    'scalar',
  ]);
  assert.deepEqual(parsed.profiles.map((p) => p.name), ['profiles[0]']);
  const w = parsed.warnings;
  assert.equal(w.length, 10);
  assert.match(w[0]!, /profile "rogue" dropped: unknown key\(s\) "blockRewardHacking"; profiles only narrow guards/);
  assert.match(w[1]!, /"\*" matches the file-mutating builtin "bash"/);
  assert.match(w[2]!, /"ba\?h" matches the file-mutating builtin "bash"/);
  assert.match(w[3]!, /unknown traceCheck key\(s\) "exemptTool"/);
  assert.match(w[4]!, /must be a non-empty array/);
  assert.match(w[5]!, /"match" must set "agent" and\/or "command"/);
  assert.match(w[6]!, /unknown match key\(s\) "repo"/);
  assert.match(w[7]!, /"match.command" must be a non-empty slash command name/);
  assert.match(w[8]!, /"traceCheck" is required/);
  assert.match(w[9]!, /profile "profiles\[10\]" dropped: must be an object/);
});

test('validateProfiles rejects wildcard globs without an MCP server prefix', () => {
  const parsed = validateProfiles([
    { name: 'any-server', match: { agent: 'a' }, traceCheck: { exemptTools: ['*_file'] } },
    { name: 'writers', match: { agent: 'a' }, traceCheck: { exemptTools: ['fs*'] } },
    { name: 'one-server', match: { agent: 'a' }, traceCheck: { exemptTools: ['filesystem_*', 'dewey-x.y_*', 'write_file'] } },
  ]);
  assert.deepEqual(parsed.profiles.map((p) => p.name), ['one-server']);
  assert.match(parsed.warnings[0]!, /profile "any-server" dropped: .*"\*_file" is too broad: a wildcard glob must start with an MCP server prefix/);
  assert.match(parsed.warnings[1]!, /profile "writers" dropped: .*"fs\*" is too broad/);
});

test('toolMayBeExempt checks globs across all profiles, regardless of session', () => {
  const { profiles } = validateProfiles([{ match: { agent: 'curator' }, traceCheck: { exemptTools: ['dewey_*'] } }]);
  assert.equal(toolMayBeExempt('dewey_search', profiles), true);
  assert.equal(toolMayBeExempt('bash', profiles), false);
  assert.equal(toolMayBeExempt('dewey_search', undefined), false);
});

test('validateProfiles rejects a non-array value and caps the count', () => {
  assert.deepEqual(validateProfiles({ curator: {} }), {
    profiles: [],
    warnings: ['"profiles" ignored: must be an array of profile objects'],
  });
  const many = Array.from({ length: MAX_PROFILES + 2 }, () => ({ match: { agent: 'a' }, traceCheck: { exemptTools: ['x'] } }));
  const parsed = validateProfiles(many);
  assert.equal(parsed.profiles.length, MAX_PROFILES);
  assert.deepEqual(parsed.warnings, [`2 profile(s) beyond the cap of ${MAX_PROFILES} dropped`]);
});

test('validateProfiles drops an over-complex glob', () => {
  const parsed = validateProfiles([{ match: { agent: 'a' }, traceCheck: { exemptTools: [`dewey_${'*'.repeat(33)}`] } }]);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0]!, /complexity bounds/);
});

test('validateSupervisorConfig keeps the rest of the file when a profile is bad', () => {
  const parsed = validateSupervisorConfig({
    lockGuards: true,
    profiles: [{ match: { agent: 'curator' }, traceCheck: { exemptTools: ['*'] } }],
  });
  assert.equal(parsed.error, null);
  assert.equal(parsed.config.lockGuards, true);
  assert.deepEqual(parsed.config.profiles, []);
  assert.equal(parsed.warnings?.length, 1);
});

test('validateSupervisorConfig rejects a non-boolean lockGuards like other toggles', () => {
  assert.equal(validateSupervisorConfig({ lockGuards: 'yes' }).error, '"lockGuards" must be a boolean');
});

const P = (name: string, match: GuardProfile['match'], exemptTools: string[]): GuardProfile => ({
  name,
  match,
  traceCheck: { exemptTools },
});

test('profileMatchesContext requires every present key to match exactly', () => {
  assert.ok(profileMatchesContext({ agent: 'curator' }, { agent: 'curator', command: 'x' }));
  assert.ok(!profileMatchesContext({ agent: 'curator' }, { agent: 'Curator' }));
  assert.ok(profileMatchesContext({ command: 'dewey-distill' }, { agent: 'autonomy', command: 'dewey-distill' }));
  assert.ok(!profileMatchesContext({ agent: 'autonomy', command: 'dewey-distill' }, { agent: 'autonomy', command: 'uf.fix-ci' }));
  assert.ok(!profileMatchesContext({ command: 'dewey-distill' }, {}));
});

test('applicableProfiles matches self or an ancestor, bounded by MAX_PROFILE_ANCESTRY', () => {
  const profiles = [P('distill', { command: 'dewey-distill' }, ['dewey_*']), P('curator', { agent: 'curator' }, ['read'])];
  assert.deepEqual(applicableProfiles([{ agent: 'general' }, { agent: 'autonomy', command: 'dewey-distill' }], profiles).map((p) => p.name), ['distill']);
  assert.deepEqual(applicableProfiles([{ agent: 'curator' }], profiles).map((p) => p.name), ['curator']);
  const deep = [...Array.from({ length: MAX_PROFILE_ANCESTRY + 1 }, () => ({ agent: 'general' })), { command: 'dewey-distill' }];
  assert.deepEqual(applicableProfiles(deep, profiles), []);
  assert.deepEqual(applicableProfiles([{ agent: 'curator' }], undefined), []);
});

test('traceExemption unions grants and names the profile', () => {
  const profiles = [P('distill', { command: 'dewey-distill' }, ['dewey_*']), P('reads', { agent: 'curator' }, ['read'])];
  const lineage = [{ agent: 'curator', command: 'dewey-distill' }];
  assert.equal(traceExemption(lineage, 'dewey_promote', profiles)?.profile, 'distill');
  assert.equal(traceExemption(lineage, 'read', profiles)?.profile, 'reads');
  assert.match(traceExemption(lineage, 'read', profiles)!.reason, /by global profile 'reads'/);
  assert.equal(traceExemption(lineage, 'edit', profiles), null);
  assert.equal(traceExemption([{ agent: 'build' }], 'dewey_promote', profiles), null);
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

test('sanitizeNonGlobalTier strips profiles and lockGuards and applies the lock', () => {
  const result = sanitizeNonGlobalTier(
    { profiles: [], lockGuards: false, requireStepReferenceInTools: false, stripMode: 'strict' as const },
    'project supervisor config file',
    true
  );
  assert.deepEqual(result.config, { stripMode: 'strict' });
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0]!, /sets profiles; ignored — guard profiles are honored only from the global config file/);
  assert.match(result.warnings[1]!, /lockGuards; ignored/);
  assert.match(result.warnings[2]!, /requireStepReferenceInTools: false; ignored/);
});

test('sanitizeNonGlobalTier strips a guard-unregistering mode only when locked', () => {
  const unlocked = sanitizeNonGlobalTier({ mode: 'repair-only' }, 'project supervisor config file', false);
  assert.equal(unlocked.config.mode, 'repair-only');
  assert.equal(unlocked.warnings.length, 0);
  const locked = sanitizeNonGlobalTier({ mode: 'repair-only' }, 'project supervisor config file', true);
  assert.equal(locked.config.mode, undefined);
  assert.equal(locked.warnings.length, 1);
  assert.match(locked.warnings[0]!, /sets mode: "repair-only"; ignored/);
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
  run: (projectDir: string, xdgRoot: string, homeDir: string) => Promise<void>
): Promise<void> {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('OPENCODE_SUPERVISOR_')) delete process.env[name];
  }
  logIdentityState.identityLogged = false;
  logIdentityState.identitySaidNoModel = false;
  const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-project-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-home-'));
  process.env.XDG_CONFIG_HOME = xdgRoot;
  const savedAccountHome = configPathState.accountHome;
  configPathState.accountHome = () => homeDir;
  if (files.global !== undefined) {
    fs.mkdirSync(path.join(xdgRoot, 'opencode', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(xdgRoot, 'opencode', 'supervisor', 'config.json'), JSON.stringify(files.global));
  }
  if (files.project !== undefined) {
    fs.mkdirSync(path.join(projectDir, '.opencode', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.opencode', 'supervisor', 'config.json'), JSON.stringify(files.project));
  }
  try {
    await run(projectDir, xdgRoot, homeDir);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
    fs.rmSync(xdgRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    configPathState.accountHome = savedAccountHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

let sessionSeq = 0;

const userMessage = (hooks: Hooks, sessionID: string, agent?: string) =>
  hooks['chat.message']!(
    { sessionID, ...(agent !== undefined ? { agent } : {}) },
    { message: { role: 'user' } as never, parts: [{ type: 'text', text: 'Curate the corpus.' } as never] }
  );

const runCommand = (hooks: Hooks, sessionID: string, command: string) =>
  hooks['command.execute.before']!({ command, sessionID, arguments: '' }, { parts: [] });

const sessionCreated = (hooks: Hooks, id: string, parentID?: string) =>
  hooks.event!({ event: { type: 'session.created', properties: { info: { id, ...(parentID ? { parentID } : {}) } } } as never });

/**
 * A session with a non-empty verified trace that does not name the corpus
 * path. `command` runs before the first user message, as a slash command
 * does; `parentID` arrives through a session.created event.
 */
async function startSession(
  hooks: Hooks,
  opts: { agent?: string; command?: string; parentID?: string } = {}
): Promise<string> {
  const sessionID = `profile-session-${++sessionSeq}`;
  await sessionCreated(hooks, sessionID, opts.parentID);
  if (opts.command !== undefined) await runCommand(hooks, sessionID, opts.command);
  await userMessage(hooks, sessionID, opts.agent);
  sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });
  return sessionID;
}

const callTool = (hooks: Hooks, sessionID: string, tool: string, args: Record<string, unknown>) =>
  hooks['tool.execute.before']!({ tool, sessionID, callID: 'call-1' }, { args });

const CURATOR_GRANT = { profiles: [{ name: 'curator', match: { agent: 'curator' }, traceCheck: { exemptTools: ['dewey_*'] } }] };
const DISTILL_GRANT = {
  profiles: [{ name: 'distill', match: { command: 'dewey-distill' }, traceCheck: { exemptTools: ['dewey_*'] } }],
};
const CORPUS_ARGS = { file: 'docs/corpus/source-17.md' };

test('FR-072: chat.message records the latest user message agent', async () => {
  await withIsolatedConfig({}, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'build' });
    assert.equal(sessionState.get(sessionID).agent, 'build');
    await userMessage(hooks, sessionID, 'curator');
    assert.equal(sessionState.get(sessionID).agent, 'curator');
    await hooks.dispose!();
  });
});

test('FR-072: the slash command is recorded without "/" and is replaced by another command', async () => {
  await withIsolatedConfig({}, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'autonomy', command: '/dewey-distill' });
    assert.equal(sessionState.get(sessionID).command, 'dewey-distill');
    await userMessage(hooks, sessionID, 'autonomy');
    assert.equal(sessionState.get(sessionID).command, 'dewey-distill');
    await runCommand(hooks, sessionID, 'uf.fix-ci');
    assert.equal(sessionState.get(sessionID).command, 'uf.fix-ci');
    await hooks.dispose!();
  });
});

const sessionIdle = (hooks: Hooks, sessionID: string) =>
  hooks.event!({ event: { type: 'session.idle', properties: { sessionID } } } as never);

const syntheticMessage = (hooks: Hooks, sessionID: string) =>
  hooks['chat.message']!(
    { sessionID, agent: 'autonomy' },
    { message: { role: 'user' } as never, parts: [{ type: 'text', text: 'Supervisor note.', synthetic: true } as never] }
  );

test('FR-072: a command scopes one task and ends at the first human message after idle', async () => {
  await withIsolatedConfig({ global: DISTILL_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'autonomy', command: 'dewey-distill' });
    // During the task, injected messages (an auto-question summary) keep it.
    await userMessage(hooks, sessionID, 'autonomy');
    assert.equal(sessionState.get(sessionID).command, 'dewey-distill');
    await sessionIdle(hooks, sessionID);
    // Synthetic messages after idle keep it.
    await syntheticMessage(hooks, sessionID);
    assert.equal(sessionState.get(sessionID).command, 'dewey-distill');
    // A human-typed message after idle starts a new task without the grant.
    await userMessage(hooks, sessionID, 'autonomy');
    assert.equal(sessionState.get(sessionID).command, undefined);
    await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    // A new command after idle is its own task.
    await sessionIdle(hooks, sessionID);
    await runCommand(hooks, sessionID, 'dewey-distill');
    await userMessage(hooks, sessionID, 'autonomy');
    assert.equal(sessionState.get(sessionID).command, 'dewey-distill');
    await hooks.dispose!();
  });
});

test('FR-072: a session.status idle event also ends the command task', async () => {
  await withIsolatedConfig({}, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'autonomy', command: 'dewey-distill' });
    await hooks.event!({ event: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } } } as never);
    await userMessage(hooks, sessionID, 'autonomy');
    assert.equal(sessionState.get(sessionID).command, undefined);
    await hooks.dispose!();
  });
});

test('FR-074: tools no profile can exempt never trigger parent lookups', async () => {
  await withIsolatedConfig({ global: DISTILL_GRANT }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const lookups: string[] = [];
    (harness.input.client.session as unknown as { get: unknown }).get = async ({ path: p }: { path: { id: string } }) => {
      lookups.push(p.id);
      return { data: { id: p.id } };
    };
    const hooks = await plugin.server(harness.input as PluginInput);
    await userMessage(hooks, 'precheck-child', 'general');
    await callTool(hooks, 'precheck-child', 'read', { filePath: 'src/a.ts' }).catch(() => undefined);
    assert.deepEqual(lookups, []);
    await hooks.dispose!();
  });
});

test('FR-074: a blocked call does not log the exemption as applied', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', { flags: '--no-verify' }), /reward-hacking/);
    const notice = (e: { level: string; message: string }) =>
      e.level === 'info' && e.message.includes("exempt from the file-path trace check by global profile 'curator'");
    assert.equal(harness.logEntries.filter(notice).length, 0);
    await callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS);
    assert.equal(harness.logEntries.filter(notice).length, 1);
    await hooks.dispose!();
  });
});

test('FR-072: session events record the parent session', async () => {
  await withIsolatedConfig({}, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    await sessionCreated(hooks, 'parent-a');
    await sessionCreated(hooks, 'child-a', 'parent-a');
    assert.equal(sessionState.get('parent-a').parentID, null);
    assert.equal(sessionState.get('child-a').parentID, 'parent-a');
    await hooks.dispose!();
  });
});

test('FR-074: a command profile grants an autonomy session that ran the command', async () => {
  await withIsolatedConfig({ global: DISTILL_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const distill = await startSession(hooks, { agent: 'autonomy', command: 'dewey-distill' });
    await assert.doesNotReject(() => callTool(hooks, distill, 'dewey_store_learning', CORPUS_ARGS));
    const fixCi = await startSession(hooks, { agent: 'autonomy', command: 'uf.fix-ci' });
    await assert.rejects(() => callTool(hooks, fixCi, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const plain = await startSession(hooks, { agent: 'autonomy' });
    await assert.rejects(() => callTool(hooks, plain, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    await hooks.dispose!();
  });
});

test('FR-074: a granted agent passes the trace check on an exempt tool', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await assert.doesNotReject(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS));
    await hooks.dispose!();
  });
});

test('FR-074: a profile with both keys needs both to match', async () => {
  const grant = {
    profiles: [{ match: { agent: 'autonomy', command: 'dewey-distill' }, traceCheck: { exemptTools: ['dewey_*'] } }],
  };
  await withIsolatedConfig({ global: grant }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const both = await startSession(hooks, { agent: 'autonomy', command: 'dewey-distill' });
    await assert.doesNotReject(() => callTool(hooks, both, 'dewey_store_learning', CORPUS_ARGS));
    const agentOnly = await startSession(hooks, { agent: 'autonomy', command: 'uf.fix-ci' });
    await assert.rejects(() => callTool(hooks, agentOnly, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const commandOnly = await startSession(hooks, { agent: 'build', command: 'dewey-distill' });
    await assert.rejects(() => callTool(hooks, commandOnly, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    await hooks.dispose!();
  });
});

test('FR-074: subagent sessions inherit the task grant through session events', async () => {
  await withIsolatedConfig({ global: DISTILL_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const parent = await startSession(hooks, { agent: 'autonomy', command: 'dewey-distill' });
    const child = await startSession(hooks, { agent: 'general', parentID: parent });
    const grandchild = await startSession(hooks, { agent: 'explore', parentID: child });
    await assert.doesNotReject(() => callTool(hooks, child, 'dewey_store_learning', CORPUS_ARGS));
    await assert.doesNotReject(() => callTool(hooks, grandchild, 'dewey_store_learning', CORPUS_ARGS));
    const unrelatedRoot = await startSession(hooks, { agent: 'autonomy', command: 'uf.fix-ci' });
    const unrelated = await startSession(hooks, { agent: 'general', parentID: unrelatedRoot });
    await assert.rejects(() => callTool(hooks, unrelated, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    await hooks.dispose!();
  });
});

test('FR-074: an unknown parent is looked up once and cached; a failed lookup grants nothing and is retried', async () => {
  await withIsolatedConfig({ global: DISTILL_GRANT }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const lookups: string[] = [];
    (harness.input.client.session as unknown as { get: unknown }).get = async ({ path: p }: { path: { id: string } }) => {
      lookups.push(p.id);
      if (p.id === 'lookup-child') return { data: { id: p.id, parentID: 'lookup-parent' } };
      if (p.id === 'lookup-parent') return { data: { id: p.id } };
      throw new Error('not found');
    };
    const hooks = await plugin.server(harness.input as PluginInput);
    await runCommand(hooks, 'lookup-parent', 'dewey-distill');
    await userMessage(hooks, 'lookup-parent', 'autonomy');
    await userMessage(hooks, 'lookup-child', 'general');
    sessionState.get('lookup-child').verifiedSteps.push({ text: 'Edit src/a.ts.', passed: true });
    await assert.doesNotReject(() => callTool(hooks, 'lookup-child', 'dewey_store_learning', CORPUS_ARGS));
    await assert.doesNotReject(() => callTool(hooks, 'lookup-child', 'dewey_store_learning', CORPUS_ARGS));
    assert.deepEqual(lookups, ['lookup-child', 'lookup-parent']);

    await userMessage(hooks, 'orphan-child', 'general');
    sessionState.get('orphan-child').verifiedSteps.push({ text: 'Edit src/a.ts.', passed: true });
    await assert.rejects(() => callTool(hooks, 'orphan-child', 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    // Not cached as a root: within the backoff no new lookup is made...
    assert.equal(sessionState.get('orphan-child').parentID, undefined);
    await assert.rejects(() => callTool(hooks, 'orphan-child', 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    assert.equal(lookups.filter((id) => id === 'orphan-child').length, 1);
    // ...and after it, the lookup runs again.
    sessionState.get('orphan-child').parentLookupRetryAt = 0;
    await assert.rejects(() => callTool(hooks, 'orphan-child', 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    assert.equal(lookups.filter((id) => id === 'orphan-child').length, 2);
    await hooks.dispose!();
  });
});

test('FR-074: other agents, unknown agents, and other tools are unchanged', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const build = await startSession(hooks, { agent: 'build' });
    await assert.rejects(() => callTool(hooks, build, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const unknown = await startSession(hooks);
    await assert.rejects(() => callTool(hooks, unknown, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const curator = await startSession(hooks, { agent: 'curator' });
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
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await assert.rejects(
      () => callTool(hooks, sessionID, 'dewey_store_learning', { flags: '--no-verify' }),
      /reward-hacking check/
    );
    await hooks.dispose!();
  });
});

test('FR-074: an applied exemption logs once per profile and tool', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS);
    await callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS);
    const notices = harness.logEntries.filter(
      (e) => e.level === 'info' && e.message.includes("exempt from the file-path trace check by global profile 'curator'")
    );
    assert.equal(notices.length, 1);
    await hooks.dispose!();
  });
});

test('FR-074: the protected-state check still blocks an exempt call', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await assert.rejects(
      () => callTool(hooks, sessionID, 'dewey_store_learning', { file: '.opencode/supervisor/approvals.json' }),
      /approvals file is engineer-authored state/
    );
    await hooks.dispose!();
  });
});

test('FR-074: an approve gate still holds an exempt call', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const directivesDir = path.join(dir, '.opencode', 'supervisor', 'directives');
    fs.mkdirSync(directivesDir, { recursive: true });
    fs.writeFileSync(
      path.join(directivesDir, 'gates.md'),
      `Curator writes are gated.\n\n\`\`\`supervisor\n${JSON.stringify({ approve: [{ id: 'curate', tool: 'dewey_store_learning' }] })}\n\`\`\`\n`
    );
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await assert.rejects(
      () => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS),
      /approval gate 'curate'/
    );
    await hooks.dispose!();
  });
});

test('FR-074: an enforce directive still blocks an exempt call', async () => {
  await withIsolatedConfig({ global: CURATOR_GRANT }, async (dir) => {
    const directivesDir = path.join(dir, '.opencode', 'supervisor', 'directives');
    fs.mkdirSync(directivesDir, { recursive: true });
    fs.writeFileSync(
      path.join(directivesDir, 'no-corpus.md'),
      `The corpus is engineer-curated.\n\n\`\`\`supervisor\n${JSON.stringify({ enforce: [{ forbidPath: 'docs/corpus/**' }] })}\n\`\`\`\n`
    );
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await assert.rejects(
      () => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS),
      /blocked by engineer directive 'no-corpus'/
    );
    await hooks.dispose!();
  });
});

test('FR-073: project and plugin-options profiles are ignored with a warning', async () => {
  await withIsolatedConfig({ project: CURATOR_GRANT }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input, { config: CURATOR_GRANT } as never);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const warns = harness.logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
    assert.ok(warns.some((m) => m.includes('project supervisor config file sets profiles; ignored')));
    assert.ok(warns.some((m) => m.includes('plugin options supervisor config sets profiles; ignored')));
    await hooks.dispose!();
  });
});

test('FR-073: a bad global profile warns and does not drop lockGuards', async () => {
  await withIsolatedConfig(
    {
      global: { lockGuards: true, profiles: [{ name: 'bad', match: { agent: 'curator' }, blockRewardHacking: false }] },
      project: { requireStepReferenceInTools: false },
    },
    async (dir) => {
      const harness = recordingPluginInput(dir);
      const hooks = await plugin.server(harness.input);
      const sessionID = await startSession(hooks, { agent: 'curator' });
      await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
      const warns = harness.logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
      assert.ok(warns.some((m) => m.includes('global supervisor config: profile "bad" dropped')));
      assert.ok(warns.some((m) => m.includes('requireStepReferenceInTools: false; ignored because the global config sets lockGuards: true')));
      await hooks.dispose!();
    }
  );
});

test('FR-075: without the lock, project config still disables the trace check', async () => {
  await withIsolatedConfig({ project: { requireStepReferenceInTools: false } }, async (dir) => {
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'build' });
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
      const sessionID = await startSession(hooks, { agent: 'build' });
      await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
      await assert.rejects(() => callTool(hooks, sessionID, 'bash', { command: 'git commit --no-verify' }), /reward-hacking/);
      const info = harness.logEntries.find((e) => e.level === 'info' && e.message.includes('lockGuards='));
      assert.match(info?.message ?? '', /blockRewardHacking=true, stepReference=true, lockGuards=true/);
      await hooks.dispose!();
    }
  );
});

test('FR-075: the lock keeps a committed project mode from disabling the guards', async () => {
  await withIsolatedConfig({ global: { lockGuards: true }, project: { mode: 'repair-only' } }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks);
    await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    assert.ok(
      harness.logEntries.some(
        (e) => e.level === 'warn' && e.message.includes('project supervisor config file sets mode: "repair-only"; ignored')
      )
    );
    await hooks.dispose!();
  });
});

test('FR-075: environment variables cannot turn guards off under the lock', async () => {
  await withIsolatedConfig({ global: { lockGuards: true } }, async (dir) => {
    process.env.OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS = 'false';
    process.env.OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING = 'false';
    process.env.OPENCODE_SUPERVISOR_MODE = 'repair-only';
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks, { agent: 'build' });
    await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    await assert.rejects(() => callTool(hooks, sessionID, 'bash', { command: 'git commit --no-verify' }), /reward-hacking check/);
    const warns = harness.logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
    assert.ok(warns.some((m) => m.includes('OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS=false; ignored')));
    assert.ok(warns.some((m) => m.includes('OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING=false; ignored')));
    assert.ok(warns.some((m) => m.includes('OPENCODE_SUPERVISOR_MODE=repair-only; ignored')));
    await hooks.dispose!();
  });
});

test('FR-075: without the lock the environment still turns guards off', async () => {
  await withIsolatedConfig({ global: {} }, async (dir) => {
    process.env.OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS = 'false';
    const hooks = await plugin.server(recordingPluginInput(dir).input);
    const sessionID = await startSession(hooks, { agent: 'build' });
    await assert.doesNotReject(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS));
    await hooks.dispose!();
  });
});

test('FR-075: a global file rejected for another key keeps lockGuards (fails closed)', async () => {
  await withIsolatedConfig(
    { global: { lockGuards: true, maxRegenerations: '3' }, project: { requireStepReferenceInTools: false } },
    async (dir) => {
      const harness = recordingPluginInput(dir);
      const hooks = await plugin.server(harness.input);
      const sessionID = await startSession(hooks, { agent: 'build' });
      await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
      const warns = harness.logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
      assert.ok(warns.some((m) => m.includes('global supervisor config file ignored except lockGuards: true')));
      await hooks.dispose!();
    }
  );
});

test('FR-075: XDG_CONFIG_HOME cannot escape a lock in the home-directory config', async () => {
  await withIsolatedConfig({ global: {}, project: { requireStepReferenceInTools: false } }, async (dir, _xdg, home) => {
    fs.mkdirSync(path.join(home, '.config', 'opencode', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'opencode', 'supervisor', 'config.json'), JSON.stringify({ lockGuards: true }));
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks, { agent: 'build' });
    await assert.rejects(() => callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS), /file-path trace check/);
    const warns = harness.logEntries.filter((e) => e.level === 'warn').map((e) => e.message);
    assert.ok(warns.some((m) => m.includes('XDG_CONFIG_HOME points the global supervisor config at')));
    await hooks.dispose!();
  });
});

test('FR-075: lockGuards outside the global file is ignored with a warning', async () => {
  await withIsolatedConfig({ project: { lockGuards: true } }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks, { agent: 'build' });
    await callTool(hooks, sessionID, 'read', { filePath: 'src/a.ts' }).catch(() => undefined);
    assert.ok(
      harness.logEntries.some((e) => e.level === 'warn' && e.message.includes('project supervisor config file sets lockGuards; ignored'))
    );
    const info = harness.logEntries.find((e) => e.level === 'info' && e.message.includes('lockGuards='));
    assert.match(info?.message ?? '', /lockGuards=false/);
    await hooks.dispose!();
  });
});

test('the identity line names the global profiles', async () => {
  await withIsolatedConfig({ global: { profiles: [...CURATOR_GRANT.profiles, ...DISTILL_GRANT.profiles] } }, async (dir) => {
    const harness = recordingPluginInput(dir);
    const hooks = await plugin.server(harness.input);
    const sessionID = await startSession(hooks, { agent: 'curator' });
    await callTool(hooks, sessionID, 'dewey_store_learning', CORPUS_ARGS);
    const info = harness.logEntries.find((e) => e.level === 'info' && e.message.includes('lockGuards='));
    assert.match(info?.message ?? '', /profiles: curator, distill/);
    await hooks.dispose!();
  });
});
