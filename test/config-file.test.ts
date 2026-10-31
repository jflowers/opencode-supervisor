import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import plugin, { resolveHookConfig } from '../index.ts';
import { logIdentityState, sessionState } from '../index.ts';
import {
  parseSupervisorConfigFile,
  validateSupervisorConfig,
  type SupervisorFileConfig,
} from '../src/config-file.ts';
import { DEFAULT_MEMO_LIMITS } from '../src/memo.ts';

// ── Pure validation (FR-057) ──────────────────────────────────────

test('validateSupervisorConfig accepts a full valid config', () => {
  const parsed = validateSupervisorConfig({
    auditorModel: 'enmaas/rits/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    auditorVariant: 'low',
    stripMode: 'balanced',
    maxRegenerations: 3,
    blockRewardHacking: false,
    requireStepReferenceInTools: false,
    memoLimits: { maxSolvedItems: 10, maxCritiques: 4, maxReminders: 6, maxReports: 3 },
    maxOnDemandAudits: 5,
  });
  assert.equal(parsed.error, null);
  assert.equal(parsed.config.auditorModel, 'enmaas/rits/deepseek-ai/DeepSeek-V4.1-Flash-1017');
  assert.equal(parsed.config.auditorVariant, 'low');
  assert.equal(parsed.config.stripMode, 'balanced');
  assert.equal(parsed.config.maxRegenerations, 3);
  assert.equal(parsed.config.blockRewardHacking, false);
  assert.equal(parsed.config.requireStepReferenceInTools, false);
  assert.deepEqual(parsed.config.memoLimits, { maxSolvedItems: 10, maxCritiques: 4, maxReminders: 6, maxReports: 3 });
  assert.equal(parsed.config.maxOnDemandAudits, 5);
});

test('validateSupervisorConfig accepts any subset and ignores unknown keys', () => {
  const parsed = validateSupervisorConfig({
    auditorModel: 'mock/auditor-model',
    futureKnob: 'ignored',
    nested: { unknown: true },
  });
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.config, { auditorModel: 'mock/auditor-model' });
});

test('validateSupervisorConfig rejects non-objects', () => {
  for (const value of [null, 'string', 42, true, [1, 2]]) {
    const parsed = validateSupervisorConfig(value);
    assert.equal(parsed.error, 'configuration must be a JSON object');
    assert.deepEqual(parsed.config, {});
  }
});

test('validateSupervisorConfig rejects wrong-typed known keys wholesale', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ auditorModel: 42 }, /"auditorModel" must be a non-empty string/],
    [{ auditorModel: '   ' }, /"auditorModel" must be a non-empty string/],
    [{ auditorVariant: 'turbo' }, /"auditorVariant" must be one of/],
    [{ stripMode: 'chaotic' }, /"stripMode" must be one of/],
    [{ maxRegenerations: -1 }, /"maxRegenerations" must be a non-negative integer/],
    [{ maxRegenerations: 'two' }, /"maxRegenerations" must be a non-negative integer/],
    [{ maxRegenerations: 2.5 }, /"maxRegenerations" must be a non-negative integer/],
    [{ maxOnDemandAudits: Number.NaN }, /"maxOnDemandAudits" must be a non-negative integer/],
    [{ maxOnDemandAudits: Number.POSITIVE_INFINITY }, /"maxOnDemandAudits" must be a non-negative integer/],
    [{ blockRewardHacking: 'yes' }, /"blockRewardHacking" must be a boolean/],
    [{ requireStepReferenceInTools: 1 }, /"requireStepReferenceInTools" must be a boolean/],
    [{ memoLimits: [] }, /"memoLimits" must be an object/],
    [{ memoLimits: { maxReminders: -2 } }, /"memoLimits.maxReminders" must be a non-negative integer/],
    [{ memoLimits: { maxReminders: 1.5 } }, /"memoLimits.maxReminders" must be a non-negative integer/],
  ];
  for (const [value, pattern] of cases) {
    const parsed = validateSupervisorConfig(value);
    assert.match(parsed.error ?? '', pattern);
    // A wrong-typed value rejects the whole tier, not just the key.
    assert.deepEqual(parsed.config, {});
  }
});

test('validateSupervisorConfig trims a whitespace-padded auditorModel slug', () => {
  const parsed = validateSupervisorConfig({ auditorModel: '  mock/auditor-model  ' });
  assert.equal(parsed.error, null);
  assert.equal(parsed.config.auditorModel, 'mock/auditor-model');
});

test('parseSupervisorConfigFile parses valid JSON and reports malformed JSON', () => {
  const parsed = parseSupervisorConfigFile('{"auditorModel":"mock/auditor-model"}');
  assert.equal(parsed.error, null);
  assert.equal(parsed.config.auditorModel, 'mock/auditor-model');

  const malformed = parseSupervisorConfigFile('{ not json');
  assert.match(malformed.error ?? '', /^invalid JSON:/);
  assert.deepEqual(malformed.config, {});

  // JSON that parses to a non-object rejects like a non-object value.
  const array = parseSupervisorConfigFile('[1,2,3]');
  assert.equal(array.error, 'configuration must be a JSON object');
});

// ── Resolution precedence (FR-056) ─────────────────────────────────

/** Every OPENCODE_SUPERVISOR_* knob, for env-cleaning around tier tests. */
const CONFIG_ENV_NAMES = [
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

/** Cleans every supervisor env knob and log-identity flag, isolating XDG_CONFIG_HOME, around one tier test. */
async function withCleanConfigEnv(run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of CONFIG_ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // The identity line and its no-model follow-up are once-per-process
  // (FR-055); reset so each tier test's harness observes its own.
  logIdentityState.identityLogged = false;
  logIdentityState.identitySaidNoModel = false;
  // Isolate the global config tier (review round 5): a real
  // ~/.config/opencode/supervisor/config.json on the host must not
  // leak into tier resolution through XDG_CONFIG_HOME. Tests that
  // set their own XDG root re-isolate on top of this one.
  const savedXdgHome = process.env.XDG_CONFIG_HOME;
  const isolatedXdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  process.env.XDG_CONFIG_HOME = isolatedXdgRoot;
  try {
    await run();
  } finally {
    for (const name of CONFIG_ENV_NAMES) {
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

test('resolveHookConfig tiers the auditor model project → options → global → derived', async () => {
  await withCleanConfigEnv(async () => {
    const all: SupervisorFileConfig = {
      auditorModel: 'project/model',
      auditorVariant: 'low',
      maxRegenerations: 5,
      memoLimits: { maxReminders: 3 },
    };
    const sources = {
      project: all,
      options: { auditorModel: 'options/model' } as SupervisorFileConfig,
      global: { auditorModel: 'global/model' } as SupervisorFileConfig,
      derivedModel: 'derived/model',
    };

    // Project wins over every later tier.
    assert.equal(resolveHookConfig(undefined, sources).auditorModel, 'project/model');
    // Options wins over global and derived.
    assert.equal(resolveHookConfig(undefined, { ...sources, project: undefined }).auditorModel, 'options/model');
    // Global wins over derived.
    assert.equal(
      resolveHookConfig(undefined, { ...sources, project: undefined, options: undefined }).auditorModel,
      'global/model'
    );
    // Derived is the last model tier.
    assert.equal(resolveHookConfig(undefined, { ...sources, project: undefined, options: undefined, global: undefined }).auditorModel, 'derived/model');
    // With nothing set, the auditor stays unset (FR-059/FR-060).
    assert.equal(resolveHookConfig(undefined, { ...sources, project: undefined, options: undefined, global: undefined, derivedModel: undefined }).auditorModel, undefined);

    // The derived tier applies to the model only — never the variant.
    const derivedOnly = resolveHookConfig(undefined, { derivedModel: 'derived/model' });
    assert.equal(derivedOnly.auditorModel, 'derived/model');
    assert.equal(derivedOnly.auditorVariant, undefined);

    // Per-knob file tiers: project maxRegenerations and memoLimits apply,
    // unmentioned memoLimits fields keep the plugin defaults.
    const tiered = resolveHookConfig(undefined, sources);
    assert.equal(tiered.maxRegenerations, 5);
    assert.equal(tiered.memoLimits.maxReminders, 3);
    assert.equal(tiered.memoLimits.maxSolvedItems, DEFAULT_MEMO_LIMITS.maxSolvedItems);
  });
});

test('resolveHookConfig keeps the environment above the file tiers', async () => {
  await withCleanConfigEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MODEL = 'env/model';
    process.env.OPENCODE_SUPERVISOR_MAX_REGENERATIONS = '9';
    const config = resolveHookConfig(undefined, {
      project: { auditorModel: 'project/model', maxRegenerations: 5 },
    });
    assert.equal(config.auditorModel, 'env/model');
    assert.equal(config.maxRegenerations, 9);
  });
});

// ── Server-level config-file integration (FR-057/FR-058/FR-060) ──

/** Event-hook input shape, for casting deliberately undeclared event payloads. */
type EventHookInput = Parameters<NonNullable<Hooks['event']>>[0];

/** A synthetic completed reasoning part with formal content (passes invariants). */
function completedReasoningPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'part-1',
    sessionID: 'config-session-1',
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

interface ServerHarness {
  input: PluginInput;
  titles: string[];
  logEntries: Array<{ level: string; message: string }>;
  configGetCalls: number;
}

/**
 * A plugin input pointed at `directory` whose side sessions record their
 * titles, whose app.log records entries, and whose config.get serves
 * `configData` (or rejects, once, when `rejectFirstGet` is set).
 */
function serverHarness(
  directory: string,
  configData: { small_model?: string; model?: string } | undefined,
  options: { rejectFirstGet?: boolean } = {}
): ServerHarness {
  const titles: string[] = [];
  const logEntries: Array<{ level: string; message: string }> = [];
  let configGetCalls = 0;
  const input = {
    client: {
      session: {
        create: async (request: unknown) => {
          titles.push((request as { body?: { title?: string } }).body?.title ?? '');
          return { data: { id: `side-${titles.length}` } };
        },
        prompt: async () => ({
          data: { info: {}, parts: [{ type: 'text', text: '{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}' }] },
        }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
      },
      app: {
        log: async (request: unknown) => {
          const body = (request as { body?: { level?: string; message?: string } }).body;
          logEntries.push({ level: body?.level ?? '', message: body?.message ?? '' });
          return {};
        },
      },
      config: {
        get: async () => {
          configGetCalls += 1;
          if (options.rejectFirstGet === true && configGetCalls === 1) {
            throw new Error('listener not up yet');
          }
          return { data: configData };
        },
      },
    },
    directory,
  };
  return {
    input: input as unknown as PluginInput,
    titles,
    logEntries,
    get configGetCalls(): number {
      return configGetCalls;
    },
  };
}

/** Creates a temp project dir with one supervisor config file. */
function makeConfigDir(configJson: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-config-'));
  fs.mkdirSync(path.join(dir, '.opencode', 'supervisor'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.opencode', 'supervisor', 'config.json'), configJson);
  return dir;
}

test('the project config file sets the auditor model end to end', async () => {
  const dir = makeConfigDir('{"auditorModel":"project/file-model","auditorVariant":"high"}');
  try {
    await withCleanConfigEnv(async () => {
      // config.get serves a model too — the project file must outrank it.
      const harness = serverHarness(dir, { model: 'derived/unused' });
      const hooks = await plugin.server(harness.input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-file-session' }));
      assert.deepEqual(harness.titles, ['supervisor-audit @ project/file-model (high)']);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed project config file is skipped with one warning and lower tiers apply', async () => {
  const dir = makeConfigDir('{ not json');
  try {
    await withCleanConfigEnv(async () => {
      const harness = serverHarness(dir, { small_model: 'derived/fallback' });
      const hooks = await plugin.server(harness.input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-malformed-session' }));
      assert.ok(
        harness.logEntries.some(
          (entry) => entry.level === 'warn' && entry.message.includes('project supervisor config file ignored: invalid JSON')
        )
      );
      assert.deepEqual(harness.titles, ['supervisor-audit @ derived/fallback']);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed auditorModel slug rejects the project config file with one warning', async () => {
  const dir = makeConfigDir('{"auditorModel": "gemini-flash"}');
  try {
    await withCleanConfigEnv(async () => {
      const harness = serverHarness(dir, { small_model: 'derived/slug-fallback' });
      const hooks = await plugin.server(harness.input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-slug-session' }));
      assert.ok(
        harness.logEntries.some(
          (entry) =>
            entry.level === 'warn' && entry.message.includes('"auditorModel" must be a provider/model slug')
        )
      );
      // The file tier is rejected whole; the derived tier still applies.
      assert.deepEqual(harness.titles, ['supervisor-audit @ derived/slug-fallback']);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the derived tier prefers small_model over model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-config-'));
  try {
    await withCleanConfigEnv(async () => {
      const harness = serverHarness(dir, { small_model: 'derived/small-model', model: 'derived/full-model' });
      const hooks = await plugin.server(harness.input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-small-model-session' }));
      assert.deepEqual(harness.titles, ['supervisor-audit @ derived/small-model']);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty small_model falls back to model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-config-'));
  try {
    await withCleanConfigEnv(async () => {
      // Review round 4: an empty-string small_model is not nullish —
      // `??` coalescing kept the derived tier on a blank slug.
      const harness = serverHarness(dir, { small_model: '', model: 'derived/model-fallback' });
      const hooks = await plugin.server(harness.input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-empty-small-model-session' }));
      assert.deepEqual(harness.titles, ['supervisor-audit @ derived/model-fallback']);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed derived lookup is retried on the next resolution (FR-058)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-config-'));
  try {
    await withCleanConfigEnv(async () => {
      const harness = serverHarness(dir, { small_model: 'derived/retry-model' }, { rejectFirstGet: true });
      const hooks = await plugin.server(harness.input);

      // First resolution: the config GET rejects (listener down at
      // bootstrap) — the step still passes through the deterministic
      // invariants, no LLM audit runs, and the degradation warns.
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-retry-session', id: 'part-r1' }));
      assert.deepEqual(harness.titles, []);
      assert.equal(harness.configGetCalls, 1);
      assert.ok(
        harness.logEntries.some((entry) => entry.level === 'warn' && entry.message.includes('LLM peer audit disabled'))
      );
      // Review round 1 (MEDIUM): a failed lookup warns distinctly from
      // authoritative absence — the frozen 'none' would otherwise be a lie.
      assert.ok(
        harness.logEntries.some((entry) => entry.level === 'warn' && entry.message.includes('host model lookup failed'))
      );
      assert.deepEqual(sessionState.get('config-retry-session').verifiedSteps, [{ text: 'the rate = 24 * 15 = 360', passed: true }]);

      // Second resolution: the retry succeeds and the audit runs.
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-retry-session', id: 'part-r2', messageID: 'msg-2' }));
      assert.deepEqual(harness.titles, ['supervisor-audit @ derived/retry-model']);
      assert.equal(harness.configGetCalls, 2);
      // Review round 1 (MEDIUM): the late resolution announces itself —
      // the identity line's earlier 'none' is not the last word.
      assert.ok(
        harness.logEntries.some(
          (entry) =>
            entry.level === 'info' && entry.message.includes('auditor model resolved: derived/retry-model')
        )
      );
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no model anywhere the LLM tier is skipped and the config GET is not re-asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-config-'));
  try {
    await withCleanConfigEnv(async () => {
      // A successful GET with no model is authoritative absence.
      const harness = serverHarness(dir, {});
      const hooks = await plugin.server(harness.input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-none-session', id: 'part-n1' }));
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-none-session', id: 'part-n2', messageID: 'msg-2' }));
      assert.deepEqual(harness.titles, []);
      assert.equal(harness.configGetCalls, 1);
      assert.ok(
        harness.logEntries.some((entry) => entry.level === 'warn' && entry.message.includes('LLM peer audit disabled'))
      );
      // FR-060: the steps still pass through the invariants and verify.
      assert.equal(sessionState.get('config-none-session').verifiedSteps.length, 2);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the identity line reports guard toggles and contributing config tiers', async () => {
  const dir = makeConfigDir('{"blockRewardHacking":false}');
  try {
    await withCleanConfigEnv(async () => {
      const harness = serverHarness(dir, { small_model: 'derived/identity-model' });
      const hooks = await plugin.server(harness.input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-identity-session' }));
      const identity = harness.logEntries.find((entry) => entry.level === 'info' && entry.message.includes('loaded'));
      assert.ok(identity, 'identity line logged');
      // Review round 1 (HIGH): a flipped guard toggle or an applied
      // config file must not be silent.
      assert.ok(identity.message.includes('guards: blockRewardHacking=false'), identity.message);
      assert.ok(identity.message.includes('stepReference=true'), identity.message);
      assert.ok(identity.message.includes('config: project file'), identity.message);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the global config file applies when XDG_CONFIG_HOME is set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-config-'));
  const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  fs.mkdirSync(path.join(xdgRoot, 'opencode', 'supervisor'), { recursive: true });
  fs.writeFileSync(
    path.join(xdgRoot, 'opencode', 'supervisor', 'config.json'),
    '{"auditorModel":"global/file-model"}'
  );
  try {
    await withCleanConfigEnv(async () => {
      // Re-isolate on top of the helper's XDG root (review round 5): the
      // helper points XDG_CONFIG_HOME at an empty temp dir, so this test
      // swaps in its own populated root while the helper runs.
      const savedXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = xdgRoot;
      try {
        const harness = serverHarness(dir, { model: 'derived/unused' });
        const hooks = await plugin.server(harness.input);
        await dispatchPart(hooks, completedReasoningPart({ sessionID: 'config-global-session' }));
        assert.deepEqual(harness.titles, ['supervisor-audit @ global/file-model']);
        await hooks.dispose!();
      } finally {
        if (savedXdg === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = savedXdg;
        }
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
});
