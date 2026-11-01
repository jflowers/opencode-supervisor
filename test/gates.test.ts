/**
 * Engineer-console gate rule kinds (FR-043..FR-048): module and hook-layer
 * tests for approve gates and review gates — the same harness shape as
 * test/directives.test.ts so the engineer-console tests read alike.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks, PluginInput, ToolContext } from '@opencode-ai/plugin';
import plugin from '../index.ts';
import { recordingPluginInput, silentClientSurface, silentPluginInput } from './mocks.ts';
import {
  approvalMatches,
  compileGates,
  evaluateApproveGate,
  evaluateReviewGates,
  matchApproveGates,
  MAX_APPROVALS,
  parseApprovals,
  type ApprovalRecord,
} from '../src/gates.ts';
import { extractPolicyPaths, type Directive } from '../src/directives.ts';
import { checkProtectedState, hasProtectedSegmentRun, normalizePathToken } from '../src/tool-guard.ts';

// ── Helpers (each test file is self-contained) ──

/** Builds one directive markdown file: advisory text plus an optional rules fence. */
function directiveFile(text: string, rules: object | null): string {
  if (!rules) return text;
  return `${text}\n\n\`\`\`supervisor\n${JSON.stringify(rules)}\n\`\`\`\n`;
}

/** Creates a temp project dir with the given directive files; returns its path. */
function makeDirectiveDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-gates-'));
  const directivesDir = path.join(dir, '.opencode', 'supervisor', 'directives');
  fs.mkdirSync(directivesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directivesDir, name), content);
  }
  return dir;
}

/** Writes the approvals file into a temp project dir. */
function writeApprovals(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, '.opencode', 'supervisor', 'approvals.json'), content);
}

// recordingPluginInput and silentPluginInput now live in ./mocks.ts
// (review rounds 2 and 4).

/** Minimal ToolContext: the console tools only read `sessionID`. */
function toolContext(sessionID: string): ToolContext {
  return { sessionID } as unknown as ToolContext;
}

/** Event-hook input shape, for casting deliberately undeclared event payloads. */
type EventHookInput = Parameters<NonNullable<Hooks['event']>>[0];

/** Dispatches one tool.execute.before through the hook with raw args. */
function dispatchToolBefore(hooks: Hooks, sessionID: string, tool: string, args: unknown): Promise<void> {
  return hooks['tool.execute.before']!({ tool, sessionID, callID: 'call-1' }, { args });
}

/** Every OPENCODE_SUPERVISOR_* knob, for env-cleaning around hook-layer tests. */
const GATES_ENV_NAMES = [
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
async function withCleanGatesEnv(run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of GATES_ENV_NAMES) {
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
    for (const name of GATES_ENV_NAMES) {
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
 * every client call — for the request_audit synergy test that needs the
 * model path. Pointed at the given project directory.
 */
function auditInput(response: string, directory: string): { input: PluginInput; calls: Record<string, unknown[]> } {
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
    directory,
  };
  return { input: input as unknown as PluginInput, calls };
}

/** The audit-passed reply the side-session model returns. */
const PASSED_AUDIT = '{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}';

/** A directive carrying approve rules, for compile and match tests. */
function approveDirective(rules: object[], id = 'prod-guard'): Directive {
  return { id, text: 'Guard production deploys.', approve: rules as Directive['approve'] };
}

// ── Pure module: compileGates (FR-043, FR-047, FR-048) ──

test('compileGates derives gate keys from explicit ids or rule indexes', () => {
  const directive = approveDirective([{ tool: 'bash' }, { id: 'deploy', tool: 'bash' }]);
  const { gates, warnings } = compileGates([directive]);
  assert.deepEqual(warnings, []);
  assert.equal(gates.approve.length, 2);
  assert.equal(gates.approve[0].key, 'prod-guard/0');
  assert.equal(gates.approve[1].key, 'deploy');
  assert.equal(gates.approve[0].directiveId, 'prod-guard');
});

test('compileGates drops a pattern-only rule whose pattern fails to compile', () => {
  const { gates, warnings } = compileGates([approveDirective([{ pattern: '(' }])]);
  assert.equal(gates.approve.length, 0);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[0].includes('failed to compile'));
  assert.ok(warnings[1].includes('no usable criterion'));
});

test('compileGates keeps a rule whose failed pattern leaves other criteria', () => {
  const { gates, warnings } = compileGates([approveDirective([{ pattern: '(', tool: 'bash' }])]);
  assert.equal(gates.approve.length, 1);
  assert.equal(gates.approve[0].tool, 'bash');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('failed to compile'));
});

test('compileGates compiles review rules with their path globs', () => {
  const directive: Directive = {
    id: 'rg',
    text: 'Billing changes need review.',
    review: [{ path: 'src/billing/**' }],
  };
  const { gates, warnings } = compileGates([directive]);
  assert.deepEqual(warnings, []);
  assert.equal(gates.review.length, 1);
  assert.equal(gates.review[0].pathGlob, 'src/billing/**');
  assert.ok(gates.review[0].regex.test('src/billing/invoice.ts'));
});

// ── Pure module: matchApproveGates (FR-043) ──

test('matchApproveGates matches tool names case-insensitively', () => {
  const { gates } = compileGates([approveDirective([{ tool: 'bash' }])]);
  const match = matchApproveGates(gates.approve, 'BASH', '{}', []);
  assert.deepEqual(match, [{ key: 'prod-guard/0', directiveId: 'prod-guard' }]);
});

test('matchApproveGates matches a full extracted path against the glob', () => {
  const { gates } = compileGates([approveDirective([{ path: 'secrets/**' }])]);
  const match = matchApproveGates(gates.approve, 'bash', '{}', ['secrets/key.pem']);
  assert.equal(match.length, 1);
  assert.equal(match[0].key, 'prod-guard/0');
});

test('matchApproveGates matches a basename when the glob is shallow', () => {
  const { gates } = compileGates([approveDirective([{ path: '*.pem' }])]);
  const match = matchApproveGates(gates.approve, 'bash', '{}', ['secrets/key.pem']);
  assert.equal(match.length, 1);
  assert.equal(match[0].key, 'prod-guard/0');
});

test('matchApproveGates applies the pattern to the raw serialized arguments', () => {
  const { gates } = compileGates([approveDirective([{ pattern: 'git push --force' }])]);
  const match = matchApproveGates(gates.approve, 'bash', '{"command":"git push --force origin main"}', []);
  assert.equal(match.length, 1);
  assert.equal(match[0].key, 'prod-guard/0');
});

test('matchApproveGates requires every present criterion to hold', () => {
  const { gates } = compileGates([approveDirective([{ tool: 'bash', path: 'secrets/**' }])]);
  const match = matchApproveGates(gates.approve, 'bash', '{}', ['docs/readme.md']);
  assert.deepEqual(match, []);
});

test('matchApproveGates returns an empty array when no gate matches', () => {
  const { gates } = compileGates([approveDirective([{ tool: 'bash' }])]);
  assert.deepEqual(matchApproveGates(gates.approve, 'edit', '{}', ['src/billing/invoice.ts']), []);
});

test('matchApproveGates collects every matching gate when policies overlap', () => {
  const { gates } = compileGates([
    approveDirective([{ id: 'broad', tool: 'bash' }]),
    approveDirective([{ id: 'narrow', tool: 'bash', path: 'ops/**' }]),
  ]);
  const match = matchApproveGates(gates.approve, 'bash', '{}', ['ops/deploy.sh']);
  assert.equal(match.length, 2);
  assert.deepEqual(match.map((m) => m.key), ['broad', 'narrow']);
});

// ── Pure module: parseApprovals and approvalMatches (FR-044) ──

test('parseApprovals reads valid approval records', () => {
  const parsed = parseApprovals('[{"gate":"deploy","note":"ok"},{"gate":"other"}]');
  assert.equal(parsed.error, null);
  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.records[0], { gate: 'deploy', note: 'ok' });
});

test('parseApprovals skips malformed entries', () => {
  const parsed = parseApprovals('[{"gate":""},{"gate":42},{"gate":"ok"}]');
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.records, [{ gate: 'ok' }]);
});

test('parseApprovals rejects a non-array file with an error', () => {
  const parsed = parseApprovals('{"gate":"x"}');
  assert.deepEqual(parsed.records, []);
  assert.equal(parsed.error, 'approvals file is not a JSON array');
});

test('parseApprovals rejects invalid JSON with an error', () => {
  const parsed = parseApprovals('{nope');
  assert.deepEqual(parsed.records, []);
  assert.ok(parsed.error?.includes('not valid JSON'));
});

test('parseApprovals bounds kept records to the most recent MAX_APPROVALS', () => {
  const entries = Array.from({ length: MAX_APPROVALS + 2 }, (_, i) => ({ gate: `g${i}` }));
  const parsed = parseApprovals(JSON.stringify(entries));
  assert.equal(parsed.error, null);
  assert.equal(parsed.records.length, MAX_APPROVALS);
  assert.equal(parsed.records[0].gate, 'g2');
  assert.equal(parsed.records[MAX_APPROVALS - 1].gate, `g${MAX_APPROVALS + 1}`);
});

test('approvalMatches matches on gate equality without an expiry', () => {
  assert.equal(approvalMatches([{ gate: 'deploy' }], 'deploy'), true);
});

test('approvalMatches rejects a different gate key', () => {
  assert.equal(approvalMatches([{ gate: 'deploy' }], 'other'), false);
});

test('approvalMatches rejects an expiry that is past', () => {
  const now = new Date('2026-10-26T00:00:00Z');
  const records: ApprovalRecord[] = [{ gate: 'deploy', expires: '2026-10-25' }];
  assert.equal(approvalMatches(records, 'deploy', now), false);
});

test('approvalMatches honors the expiry day inclusively', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const records: ApprovalRecord[] = [{ gate: 'deploy', expires: '2026-10-26' }];
  assert.equal(approvalMatches(records, 'deploy', now), true);
});

test('approvalMatches never matches an unparseable expiry', () => {
  const records: ApprovalRecord[] = [{ gate: 'deploy', expires: 'soon' }];
  assert.equal(approvalMatches(records, 'deploy'), false);
});

// ── Pure module: evaluateApproveGate (FR-043, FR-045) ──

test('evaluateApproveGate fails closed on a read error', () => {
  const decision = evaluateApproveGate(
    { key: 'deploy', directiveId: 'gates' },
    'bash',
    [],
    'EACCES: permission denied'
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('could not be read'));
  assert.ok(decision.reason.includes('EACCES: permission denied'));
  assert.ok(decision.reason.includes('fails closed'));
});

test('evaluateApproveGate admits an approved gate', () => {
  const decision = evaluateApproveGate(
    { key: 'deploy', directiveId: 'gates' },
    'bash',
    [{ gate: 'deploy' }],
    null
  );
  assert.equal(decision.allowed, true);
});

test('evaluateApproveGate blocks an unapproved gate with the approval instruction', () => {
  const decision = evaluateApproveGate({ key: 'deploy', directiveId: 'gates' }, 'bash', [], null);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('engineer approval required'));
  assert.ok(decision.reason.includes('approvals.json'));
  assert.ok(decision.reason.includes('{"gate": "deploy"}'));
});

// ── Pure module: evaluateReviewGates (FR-047) ──

test('evaluateReviewGates blocks a touched path absent from the trace', () => {
  const { gates } = compileGates([{
    id: 'rg',
    text: 'Billing changes need review.',
    review: [{ path: 'src/billing/**' }],
  }]);
  const decision = evaluateReviewGates(gates.review, 'edit', ['src/billing/invoice.ts'], [
    { text: 'unrelated work', passed: true },
  ]);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('review gate'));
  assert.ok(decision.reason.includes('src/billing/invoice.ts'));
  assert.ok(decision.reason.includes('request_audit'));
});

test('evaluateReviewGates admits a path referenced by basename', () => {
  const { gates } = compileGates([{
    id: 'rg',
    text: 'Billing changes need review.',
    review: [{ path: 'src/billing/**' }],
  }]);
  const decision = evaluateReviewGates(
    gates.review,
    'edit',
    ['src/billing/invoice.ts'],
    [{ text: 'refactoring invoice.ts for the rate change', passed: true }]
  );
  assert.equal(decision.allowed, true);
});

test('evaluateReviewGates ignores a minor-failed trace entry (FR-063)', () => {
  const { gates } = compileGates([{
    id: 'rg',
    text: 'Billing changes need review.',
    review: [{ path: 'src/billing/**' }],
  }]);
  // A no-evict entry references the gated path but carries its failed
  // outcome: only a step the audit passed counts as verified reasoning,
  // so the gate still holds and points at request_audit.
  const decision = evaluateReviewGates(
    gates.review,
    'edit',
    ['src/billing/invoice.ts'],
    [{ text: 'refactoring invoice.ts for the rate change', passed: false }]
  );
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes('review gate'));
  assert.ok(decision.reason.includes('request_audit'));
});

test('evaluateReviewGates blocks on an empty trace', () => {
  const { gates } = compileGates([{
    id: 'rg',
    text: 'Billing changes need review.',
    review: [{ path: 'src/billing/**' }],
  }]);
  const decision = evaluateReviewGates(gates.review, 'edit', ['src/billing/invoice.ts'], []);
  assert.equal(decision.allowed, false);
});

test('evaluateReviewGates blocks a trailing-slash path on an empty trace', () => {
  const { gates } = compileGates([{
    id: 'rg',
    text: 'Billing changes need review.',
    review: [{ path: 'src/billing/**' }],
  }]);
  const decision = evaluateReviewGates(gates.review, 'bash', ['src/billing/'], []);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes("'src/billing/'"), decision.reason);
});

test('evaluateReviewGates matches trace references case-insensitively', () => {
  const { gates } = compileGates([{
    id: 'rg',
    text: 'Billing changes need review.',
    review: [{ path: 'src/billing/**' }],
  }]);
  const decision = evaluateReviewGates(
    gates.review,
    'edit',
    ['src/billing/invoice.ts'],
    [{ text: 'UPDATING SRC/BILLING/INVOICE.TS NOW', passed: true }]
  );
  assert.equal(decision.allowed, true);
});

// ── Hook layer: approve gates, review gates, and the audit path (FR-043..FR-048) ──

test('an unapproved approve gate blocks the call with the gate key and instruction', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'gates.md': directiveFile('Deploys are gated.', { approve: [{ id: 'deploy', tool: 'bash' }] }),
    });
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-block-1', 'bash', { command: 'deploy.sh' }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes("engineer directive 'gates'"), message);
          assert.ok(message.includes("approval gate 'deploy'"), message);
          assert.ok(message.includes('engineer approval required'), message);
          assert.ok(message.includes('approvals.json'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a recorded approval admits the gate and logs the grant once', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'gates.md': directiveFile('Deploys are gated.', { approve: [{ id: 'deploy', tool: 'bash' }] }),
    });
    writeApprovals(dir, '[{"gate":"deploy","note":"ok"}]');
    const { input, logEntries } = recordingPluginInput(dir);
    try {
      const hooks = await plugin.server(input);
      await dispatchToolBefore(hooks, 'gate-approve-1', 'bash', { command: 'deploy.sh' });
      await dispatchToolBefore(hooks, 'gate-approve-1', 'bash', { command: 'deploy.sh' });
      // FR-043: the grant rides the server log, once per gate key.
      const grants = logEntries.filter(
        (entry) =>
          entry.level === 'info' && entry.message.includes("gate 'deploy' of directive 'gates' approved for tool 'bash'")
      );
      assert.equal(grants.length, 1);
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('removing the approval blocks the next call', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'gates.md': directiveFile('Deploys are gated.', { approve: [{ id: 'deploy', tool: 'bash' }] }),
    });
    writeApprovals(dir, '[{"gate":"deploy"}]');
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await dispatchToolBefore(hooks, 'gate-revoke-1', 'bash', { command: 'deploy.sh' });
      writeApprovals(dir, '[]');
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-revoke-1', 'bash', { command: 'deploy.sh' }),
        /engineer approval required/
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a malformed approvals file fails closed with the parse error', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'gates.md': directiveFile('Deploys are gated.', { approve: [{ id: 'deploy', tool: 'bash' }] }),
    });
    writeApprovals(dir, '{nope');
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-malformed-1', 'bash', { command: 'deploy.sh' }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('could not be read'), message);
          assert.ok(message.includes('not valid JSON'), message);
          assert.ok(message.includes('fails closed'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('an absent approvals file blocks with the instruction, not an error', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'gates.md': directiveFile('Deploys are gated.', { approve: [{ id: 'deploy', tool: 'bash' }] }),
    });
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-absent-1', 'bash', { command: 'deploy.sh' }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer approval required'), message);
          assert.ok(!message.includes('could not be read'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a review gate blocks a path without a trace reference', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'review-gates.md': directiveFile('Billing changes need review.', { review: [{ path: 'src/billing/**' }] }),
    });
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-review-1', 'edit', { path: 'src/billing/invoice.ts' }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('review gate'), message);
          assert.ok(message.includes('src/billing/invoice.ts'), message);
          assert.ok(message.includes('request_audit'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a review-gated call proceeds after request_audit references the path', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'review-gates.md': directiveFile('Billing changes need review.', { review: [{ path: 'src/billing/**' }] }),
    });
    try {
      const { input } = auditInput(PASSED_AUDIT, dir);
      const hooks = await plugin.server(input);
      const sessionID = 'gate-synergy-1';
      await assert.rejects(
        dispatchToolBefore(hooks, sessionID, 'edit', { path: 'src/billing/invoice.ts' }),
        /review gate/
      );
      // The console tools are exempt from the gates, so the audit channel stays open.
      await dispatchToolBefore(hooks, sessionID, 'request_audit', {
        focus: 'update src/billing/invoice.ts: the rate = 24 * 15 = 360',
      });
      const result = await hooks.tool!.request_audit.execute(
        { focus: 'update src/billing/invoice.ts: the rate = 24 * 15 = 360' },
        toolContext(sessionID)
      );
      assert.ok(typeof result === 'string');
      assert.ok(result.startsWith('Audit passed'), result);
      await dispatchToolBefore(hooks, sessionID, 'edit', { path: 'src/billing/invoice.ts' });
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a call that matches no gate proceeds untouched', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'gates.md': directiveFile('Deploys are gated.', { approve: [{ tool: 'bash' }] }),
    });
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await dispatchToolBefore(hooks, 'gate-pass-1', 'edit', { path: 'src/other/file.ts' });
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('an overlapping approve gate set blocks on the first unapproved gate', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'broad.md': directiveFile('Broad gate.', { approve: [{ id: 'broad', tool: 'bash' }] }),
      'narrow.md': directiveFile('Narrow gate.', { approve: [{ id: 'narrow', tool: 'bash', path: 'ops/**' }] }),
    });
    writeApprovals(dir, '[{"gate":"broad"}]');
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-multi-1', 'bash', { command: 'sh ops/deploy.sh' }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes("approval gate 'narrow'"), message);
          assert.ok(message.includes('engineer approval required'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('a review gate blocks a trailing-slash path on an empty trace', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'review-gates.md': directiveFile('Billing changes need review.', { review: [{ path: 'src/billing/**' }] }),
    });
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-slash-1', 'bash', { command: 'rm -rf src/billing/' }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('review gate'), message);
          assert.ok(message.includes('src/billing/'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── checkProtectedState (pure, FR-061) ──

test('normalizePathToken folds leading dots, separators, and traversal', () => {
  assert.equal(
    normalizePathToken('.opencode/supervisor/approvals.json'),
    'opencode/supervisor/approvals.json'
  );
  assert.equal(
    normalizePathToken('.opencode/supervisor/../supervisor/config.json'),
    'opencode/supervisor/config.json'
  );
});

test('hasProtectedSegmentRun matches consecutive segment runs only', () => {
  assert.ok(
    hasProtectedSegmentRun('a/opencode/supervisor/directives/file.md', 'opencode/supervisor/directives')
  );
  assert.ok(
    !hasProtectedSegmentRun('opencode/supervisor/directives-backup/b', 'opencode/supervisor/directives')
  );
  assert.ok(hasProtectedSegmentRun('opencode/supervisor/approvals.json', 'approvals.json'));
  assert.ok(!hasProtectedSegmentRun('stale-approvals.json', 'approvals.json'));
});

test('hasProtectedSegmentRun matches glob spellings of protected runs', () => {
  // Review round 5: bash expands `su*ervisor` and `app*vals.json`
  // onto the protected path at execution time — exact-segment
  // equality alone was a bypass.
  assert.ok(hasProtectedSegmentRun('opencode/su*ervisor/app*vals.json', 'approvals.json'));
  assert.ok(
    hasProtectedSegmentRun('opencode/[s]upervisor/config.json', 'opencode/supervisor/config.json')
  );
  assert.ok(
    hasProtectedSegmentRun('config/opencode/su?ervisor/config.json', 'opencode/supervisor/config.json')
  );
  // A glob that does not expand onto the needle still misses.
  assert.ok(!hasProtectedSegmentRun('opencode/app*valsx.json', 'approvals.json'));
});

test('hasProtectedSegmentRun fails toward blocking on over-long glob segments (review iteration 3)', () => {
  // An over-long glob segment (>4096 chars) cannot be matched
  // within bounds, and in the protected-state context a
  // non-match is an evasion — so the cap fails toward matching
  // (blocking). Absurd input, safe to block.
  const overLong = `su${'a'.repeat(4100)}*ervisor`;
  assert.ok(hasProtectedSegmentRun(`x/${overLong}`, 'supervisor'));
  // Sanity: a long segment without glob metachars still only
  // matches by exact equality.
  const overLongPlain = `su${'a'.repeat(4100)}ervisor`;
  assert.ok(!hasProtectedSegmentRun(`x/${overLongPlain}`, 'supervisor'));
});

test('checkProtectedState blocks the approvals file for non-bash tools', () => {
  const reason = checkProtectedState('read', { path: '.opencode/supervisor/approvals.json' }, []);
  assert.ok(reason !== null, 'expected the approvals file to be blocked');
  assert.ok(reason!.includes('approvals file'), reason!);
});

test('checkProtectedState blocklists write content rather than keys', () => {
  // Review round 4: the 2.4.0 guard was key-agnostic; the round-3
  // operational-key allowlist regressed custom/MCP keys. The
  // CONTENT_ARG_KEYS blocklist restores coverage without scanning
  // write content — a mention inside a file being written is data.
  const reason = checkProtectedState('write', {
    filePath: 'README.md',
    content: 'see .opencode/supervisor/approvals.json for details',
  }, []);
  assert.equal(reason, null);
});

test('checkProtectedState catches slash-free bash spellings', () => {
  const reason = checkProtectedState(
    'bash',
    { command: 'cd .opencode/supervisor && cat config.json' },
    []
  );
  assert.ok(reason !== null, 'expected the config file to be blocked');
  assert.ok(reason!.includes('supervisor config file'), reason!);
});

test('checkProtectedState allows lookalike approval filenames', () => {
  // Review round 4: 'stale-approvals.json' contains the
  // 'approvals.json' substring but names a different file — the
  // path lens matches whole segments and the raw lens matches
  // token boundaries, so neither fires.
  assert.equal(checkProtectedState('read', { path: 'stale-approvals.json' }, []), null);
  assert.equal(checkProtectedState('bash', { command: 'cat stale-approvals.json' }, []), null);
});

test('checkProtectedState blocks glob spellings for non-bash tools', () => {
  // Review round 5: extraction fragmented glob tokens at the
  // metacharacter, and exact-segment matching missed the pieces.
  const configReason = checkProtectedState('read', { path: '.opencode/[s]upervisor/config.json' }, []);
  assert.ok(configReason !== null, 'expected the bracket-glob config spelling to be blocked');
  assert.ok(configReason!.includes('supervisor config file'), configReason!);
  const directivesReason = checkProtectedState(
    'read',
    { target: '.opencode/su*ervisor/dir*ives/rule.md' },
    []
  );
  assert.ok(directivesReason !== null, 'expected the star-glob directives spelling to be blocked');
  assert.ok(directivesReason!.includes('supervisor directives'), directivesReason!);
});

test('checkProtectedState blocks bash glob spellings end to end', () => {
  // The bash branch consumes argPaths as-is, so this also proves
  // the extended extractor keeps glob tokens whole.
  const command = `echo '{"gate":"deploy"}' > .opencode/su*ervisor/app*vals.json`;
  const argPaths = extractPolicyPaths({ command });
  assert.ok(argPaths.includes('.opencode/su*ervisor/app*vals.json'), argPaths.join(', '));
  const reason = checkProtectedState('bash', { command }, argPaths);
  assert.ok(reason !== null, 'expected the glob approvals spelling to be blocked');
  assert.ok(reason!.includes('approvals file'), reason!);
});

test('the agent cannot touch the approvals file', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-1', 'bash', {
          command: 'cat .opencode/supervisor/approvals.json',
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('approvals.json'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('the agent cannot touch the supervisor config file', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-2', 'bash', {
          command: 'cat .opencode/supervisor/config.json',
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('supervisor config file'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('traversal spellings of the supervisor config file are still blocked (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-3', 'bash', {
          command: 'cat .opencode/supervisor/../supervisor/config.json',
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('supervisor config file'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('slash-free cd spellings of the supervisor config file are still blocked (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-4', 'bash', {
          // The path extractor tokenizes `cd .opencode/supervisor`
          // but cannot extract the slash-free `config.json` — the
          // raw-arguments pairing lens catches it.
          command: 'cd .opencode/supervisor && cat config.json',
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('supervisor config file'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('the agent cannot touch the supervisor directives directory (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-5', 'bash', {
          command: 'rm .opencode/supervisor/directives/no-forbid.md',
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('supervisor directives'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('the agent cannot delete the supervisor state directory (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-6', 'bash', {
          command: 'rm -rf .opencode/supervisor',
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('supervisor state directory'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('write-tool content that mentions protected state is not blocked (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      // Mentioning the protected path inside a document edit is not
      // touching it: the raw lens reads only bash commands, and the
      // path lens reads only operational argument keys — the write
      // payload's content is data, not an operation (review round 3).
      await assert.doesNotReject(() =>
        dispatchToolBefore(hooks, 'gate-self-7', 'write', {
          filePath: 'README.md',
          content: 'see .opencode/supervisor/config.json for details',
        })
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('custom tool keys cannot touch the approvals file (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      // Review round 4: the 2.4.0 guard matched any argument key; the
      // round-3 operational-key allowlist let custom/MCP keys like
      // `target` through. The CONTENT_ARG_KEYS blocklist restores
      // key-agnostic coverage without scanning write content.
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-8', 'mcp-file-read', {
          target: '.opencode/supervisor/approvals.json',
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('approvals.json'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('lookalike approval filenames are not blocked (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      // Review round 4: 'stale-approvals.json' contains the
      // 'approvals.json' substring but names a different file — the
      // path lens matches whole segments and the raw lens matches
      // token boundaries, so neither fires.
      await assert.doesNotReject(() =>
        dispatchToolBefore(hooks, 'gate-self-9', 'bash', {
          command: 'cat stale-approvals.json',
        })
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('bash glob spellings cannot touch protected state (FR-061)', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({});
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      // Review round 5: the shell expands `su*ervisor`/`app*vals.json`
      // onto the protected path at execution time — the guard must
      // match glob spellings, not only exact segments.
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-self-10', 'bash', {
          command: `echo '{"gate":"deploy"}' > .opencode/su*ervisor/app*vals.json`,
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('engineer-authored state'), message);
          assert.ok(message.includes('approvals.json'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('an oversized approvals file fails closed', async () => {
  await withCleanGatesEnv(async () => {
    const dir = makeDirectiveDir({
      'gates.md': directiveFile('Deploys are gated.', { approve: [{ id: 'prod-deploy', tool: 'bash' }] }),
    });
    writeApprovals(dir, '[' + '"x",'.repeat(40000) + '"x"]');
    try {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'gate-oversize-1', 'bash', { command: 'deploy.sh' }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.ok(message.includes('exceeding'), message);
          assert.ok(message.includes('read bound'), message);
          return true;
        }
      );
      await hooks.dispose!();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
