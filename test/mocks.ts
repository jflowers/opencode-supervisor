import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';

/** Minimal ToolContext: the console tools only read `sessionID` (review round 2, #22). */
export function toolContext(sessionID: string): ToolContext {
  return { sessionID } as unknown as ToolContext;
}

/**
 * A synthetic completed reasoning part (the SDK's terminal publication
 * shape) whose text passes the deterministic invariants. Overrides
 * replace any field, including `sessionID`.
 */
export function completedReasoningPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Every OPENCODE_SUPERVISOR_* knob, cleaned around hook-layer tests (#22: one list, not one per file). */
export const SUPERVISOR_ENV_NAMES = [
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
  'OPENCODE_SUPERVISOR_MAX_COVERED_TIMEOUT_FAIL_OPENS',
  'OPENCODE_SUPERVISOR_MODE',
  'OPENCODE_SUPERVISOR_REPAIR_MODEL',
];

/**
 * Saves and deletes every supervisor env knob and isolates
 * XDG_CONFIG_HOME around `run`, restoring both afterward. The XDG
 * isolation (review round 5) keeps a real
 * ~/.config/opencode/supervisor/config.json on the host out of tier
 * resolution. Tests that set their own XDG root re-isolate on top.
 */
export async function withCleanSupervisorEnv(run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of SUPERVISOR_ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  const savedXdgHome = process.env.XDG_CONFIG_HOME;
  const isolatedXdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  process.env.XDG_CONFIG_HOME = isolatedXdgRoot;
  try {
    await run();
  } finally {
    for (const name of SUPERVISOR_ENV_NAMES) {
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
 * Shared hook-layer test mock (review round 2, CS-004): a plugin
 * input whose `app.log` records entries, for log-routing tests
 * (FR-052). Previously duplicated across the audit, directives, and
 * gates test files.
 */
export function recordingPluginInput(
  directory: string = '/tmp/supervisor-test'
): { input: PluginInput; logEntries: Array<{ level: string; message: string }> } {
  const logEntries: Array<{ level: string; message: string }> = [];
  const input = {
    client: {
      session: {
        create: async () => ({ data: { id: 'mock-side-session' } }),
        prompt: async () => ({ data: { info: {}, parts: [] } }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
      },
      app: {
        log: async (options: unknown) => {
          const body = (options as { body?: { level?: string; message?: string } }).body;
          logEntries.push({ level: body?.level ?? '', message: body?.message ?? '' });
          return {};
        },
      },
      config: { get: async () => ({ data: { small_model: 'mock/derived-model' } }) },
    },
    directory,
  };
  return { input: input as unknown as PluginInput, logEntries };
}

/**
 * Shared hook-layer test mock (review round 4): a silent plugin input —
 * `app.log` is a no-op and `config.get` serves a derived model — for
 * tests that exercise hook behavior rather than log routing. Previously
 * the dominant inline stub across the audit, console, directives,
 * gates, and reminders test files.
 */
export function silentPluginInput(directory: string = '/tmp/supervisor-test'): PluginInput {
  const input = {
    client: {
      session: {
        create: async () => ({ data: { id: 'mock-side-session' } }),
        prompt: async () => ({ data: { info: {}, parts: [] } }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
        delete: async () => ({}),
      },
      app: {
        log: async () => ({}),
      },
      config: { get: async () => ({ data: { small_model: 'mock/derived-model' } }) },
    },
    directory,
  };
  return input as unknown as PluginInput;
}

/**
 * Shared silent client surface (review round 5): spread into bespoke
 * mock clients so hand-built harnesses get the same no-op `app.log`
 * and derived-model `config.get` as `silentPluginInput` without
 * re-copying the pair. Tests that need a different `config.get`
 * (an empty config, to keep no model resolved) keep that part
 * inline after the spread.
 */
export const silentClientSurface = {
  app: { log: async () => ({}) },
  config: { get: async () => ({ data: { small_model: 'mock/derived-model' } }) },
};
