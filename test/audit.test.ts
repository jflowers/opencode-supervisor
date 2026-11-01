import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import plugin, { createInvokeModel, PLUGIN_VERSION, resolveHookConfig, sessionState, traceAwaitState } from '../index.ts';
import { recordingPluginInput, silentClientSurface, silentPluginInput } from './mocks.ts';
import { stripNarrative } from '../src/stripper.ts';
import {
  checkDeterministicInvariants,
  resolveAuditorConfig,
  runPeerAudit,
  type AuditConfig,
  type InvokeModel,
} from '../src/auditor.ts';
import { extractArgPaths, verifyToolIntent } from '../src/tool-guard.ts';
import { extractPathTokens, hasPathToken, isPatternToken } from '../src/path-tokens.ts';
import { DEFAULT_MEMO_LIMITS } from '../src/memo.ts';
import { silentPluginLogger } from '../src/plugin-log.ts';

test('stripNarrative isolates code and math steps', () => {
  const steps = [
    'First let us think about the problem.',
    'rate = 24 * 15 = 360',
    '```ts\nconst ok = true;\n```',
  ];
  const cleaned = stripNarrative(steps, 'code_and_math');
  assert.equal(cleaned.length, 2);
});

test('stripNarrative keeps path-bearing prose in code_and_math and balanced, drops it in strict (FR-068)', () => {
  // The corrective loop's premise: a step naming a file in plain prose
  // must reach the audit and the trace, or the guard's block reason
  // can never be satisfied (design D9).
  const steps = ['I will update notes.md with the session summary.'];
  assert.equal(stripNarrative(steps, 'code_and_math').length, 1);
  assert.equal(stripNarrative(steps, 'balanced').length, 1);
  // Strict is unchanged: zero natural language is its contract.
  assert.equal(stripNarrative(steps, 'strict').length, 0);
  // Narrative-prefix removal still applies to the surviving step —
  // survival and prefix stripping are independent clauses.
  assert.equal(stripNarrative(steps, 'code_and_math')[0], 'update notes.md with the session summary.');
});

test('resolveAuditorConfig respects session model slug and variant overrides', () => {
  const resolved = resolveAuditorConfig(
    {
      auditorModel: 'mock/auditor-model',
      auditorVariant: 'low',
      stripMode: 'code_and_math',
      maxRegenerations: 2,
      blockRewardHacking: true,
      requireStepReferenceInTools: true,
    },
    {
      config: {
        plugins: {
          'opencode-supervisor': {
            auditorModel: 'openai/o3-mini',
            auditorVariant: 'high',
          },
        },
      },
    }
  );
  assert.equal(resolved.auditorModel, 'openai/o3-mini');
  assert.equal(resolved.auditorVariant, 'high');
});

const baseAuditConfig: AuditConfig = {
  auditorModel: 'mock/auditor-model',
  auditorVariant: 'low',
  stripMode: 'code_and_math',
  maxRegenerations: 2,
  blockRewardHacking: true,
  requireStepReferenceInTools: true,
};

// FR-052: createInvokeModel logs delete failures through the plugin
// logger — the shared silentPluginLogger keeps these adapter tests
// focused on the side-session call contract (review round 5).

// Tripwire mock: any call flips the outcome to fail-open, failing the test.
const neverInvokeModel: InvokeModel = async () => {
  throw new Error('invokeModel must not be called');
};

test('resolveAuditorConfig falls back from session config to environment to defaults', () => {
  const savedModel = process.env.OPENCODE_SUPERVISOR_MODEL;
  const savedVariant = process.env.OPENCODE_SUPERVISOR_VARIANT;
  process.env.OPENCODE_SUPERVISOR_MODEL = 'anthropic/env-model';
  process.env.OPENCODE_SUPERVISOR_VARIANT = 'medium';
  try {
    const fromEnv = resolveAuditorConfig(baseAuditConfig);
    assert.equal(fromEnv.auditorModel, 'anthropic/env-model');
    assert.equal(fromEnv.auditorVariant, 'medium');

    const fromSession = resolveAuditorConfig(baseAuditConfig, {
      config: {
        plugins: {
          'opencode-supervisor': {
            auditorModel: 'openai/session-model',
            auditorVariant: 'high',
          },
        },
      },
    });
    assert.equal(fromSession.auditorModel, 'openai/session-model');
    assert.equal(fromSession.auditorVariant, 'high');
  } finally {
    if (savedModel === undefined) {
      delete process.env.OPENCODE_SUPERVISOR_MODEL;
    } else {
      process.env.OPENCODE_SUPERVISOR_MODEL = savedModel;
    }
    if (savedVariant === undefined) {
      delete process.env.OPENCODE_SUPERVISOR_VARIANT;
    } else {
      process.env.OPENCODE_SUPERVISOR_VARIANT = savedVariant;
    }
  }
});

test('runPeerAudit passes without a model call when there are no steps', async () => {
  let calls = 0;
  const invokeModel: InvokeModel = async () => {
    calls += 1;
    return '{"passed":true}';
  };
  const outcome = await runPeerAudit([], baseAuditConfig, invokeModel);
  assert.equal(outcome.passed, true);
  assert.equal(calls, 0);
});

test('runPeerAudit fails an arithmetic invariant without invoking the model', async () => {
  let calls = 0;
  const invokeModel: InvokeModel = async () => {
    calls += 1;
    return '{"passed":true}';
  };
  const outcome = await runPeerAudit(
    ['capacity = 24 * 15 = 340'],
    baseAuditConfig,
    invokeModel,
    'Compute the total capacity'
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failedStep, 1);
  assert.equal(outcome.severity, 'minor');
  assert.equal(outcome.source, 'invariants');
  assert.equal(calls, 0);
});

test('arithmetic invariant verifies the full chain, not the last binary pair (#35, FR-062)', async () => {
  // Regression strings from the field session (ses_e72a74b18ffeOU3uNACKZ9k1Jz):
  // the binary-pair matcher checked `38+16+2=56` as `16+2=56` and failed
  // every correct chained sum, vanishing each part's path mentions from
  // the trace. Full-chain evaluation verifies them as one expression.
  const correctChains = [
    'capacity: 38+16+2=56',
    'tally = 1+1+3+2+2+2+9 = 20',
    'sum: 456+139+62=657',
    'recount = 133+3+521=657',
    'total 31+3+623=657',
  ];
  for (const step of correctChains) {
    // No auditor model: the invariants are the whole audit, so a pass here
    // means the chain tier specifically declined to flag the step.
    const outcome = await runPeerAudit([step], { ...baseAuditConfig, auditorModel: undefined }, neverInvokeModel);
    assert.equal(outcome.passed, true, step);
  }
});

test('arithmetic invariant still fails genuinely misstated chains and pairs (#35)', () => {
  const chain = checkDeterministicInvariants(['batch total 9+3+2=56']);
  assert.ok(chain !== null);
  assert.equal(chain.passed, false);
  assert.equal(chain.severity, 'minor');
  assert.equal(chain.source, 'invariants');

  const pair = checkDeterministicInvariants(['count = 16 + 2 = 56']);
  assert.ok(pair !== null);
  assert.equal(pair.passed, false);

  const product = checkDeterministicInvariants(['pairs = 2 * 3 = 8']);
  assert.ok(product !== null);
  assert.equal(product.passed, false);
});

test('arithmetic invariant applies standard precedence inside chains (FR-062)', async () => {
  // Multiplication binds before addition: 2+3*4 is 14, not 20.
  const correct = await runPeerAudit(['terms = 2+3*4 = 14'], { ...baseAuditConfig, auditorModel: undefined }, neverInvokeModel);
  assert.equal(correct.passed, true);

  const misstated = checkDeterministicInvariants(['terms = 2+3*4 = 20']);
  assert.ok(misstated !== null);
  assert.equal(misstated.passed, false);
});

test('arithmetic invariant declines to judge division by zero (FR-062)', async () => {
  // The fail-open posture the binary-pair matcher already took on a/0:
  // an un-evaluable chain passes unchecked rather than guessing.
  const outcome = await runPeerAudit(['ratio = 10 / 0 = 0'], { ...baseAuditConfig, auditorModel: undefined }, neverInvokeModel);
  assert.equal(outcome.passed, true);
});

test('arithmetic critique quotes the whole stated expression (FR-062)', () => {
  const outcome = checkDeterministicInvariants(['batch total 9+3+2=56']);
  assert.ok(outcome !== null);
  // The corrective signal names the full span — operand chain and stated
  // total — so the supervised model can see exactly what it misstated.
  assert.ok(outcome.critique.includes('stated 9+3+2=56'), outcome.critique);
  assert.ok(outcome.critique.includes('evaluates to 14'), outcome.critique);
});

test('runPeerAudit classifies an off-by-one loop bound as minor', async () => {
  const outcome = await runPeerAudit(
    ['for (let i = 0; i <= items.length; i++) { total += items[i]; }'],
    baseAuditConfig,
    neverInvokeModel
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.severity, 'minor');
});

test('runPeerAudit classifies reward-hacking markers as severe', async () => {
  const noVerify = await runPeerAudit(
    ['git commit --no-verify -m "bypass hooks"'],
    baseAuditConfig,
    neverInvokeModel
  );
  assert.equal(noVerify.passed, false);
  assert.equal(noVerify.severity, 'severe');

  const deleteTests = await runPeerAudit(['rm -rf tests'], baseAuditConfig, neverInvokeModel);
  assert.equal(deleteTests.passed, false);
  assert.equal(deleteTests.severity, 'severe');
});

test('runPeerAudit includes the goal, severity guidance, and steps in the prompt', async () => {
  let seenPrompt = '';
  const invokeModel: InvokeModel = async (prompt) => {
    seenPrompt = prompt;
    return '{"passed":true,"failedStep":null,"severity":null,"critique":"All steps verified."}';
  };
  const outcome = await runPeerAudit(
    ['rate = 24 * 15 = 360'],
    baseAuditConfig,
    invokeModel,
    'Refactor the login module'
  );
  assert.equal(outcome.passed, true);
  assert.ok(seenPrompt.includes('Refactor the login module'));
  assert.ok(seenPrompt.includes('Scope drift'));
  assert.ok(seenPrompt.includes('severity'));
  assert.ok(seenPrompt.includes('Step 1: rate = 24 * 15 = 360'));
});

test('runPeerAudit extracts the verdict leniently from JSON embedded in prose', async () => {
  let seenPrompt = '';
  const invokeModel: InvokeModel = async (prompt) => {
    seenPrompt = prompt;
    return 'Audit complete.```json\n{"passed":false,"failedStep":2,"severity":"minor","critique":"Step 2 assumes the sorted invariant holds."}\n```\nThat is my finding.';
  };
  const outcome = await runPeerAudit(['a = 1 + 1 = 2', 'b = 2 + 2 = 4'], baseAuditConfig, invokeModel);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failedStep, 2);
  assert.equal(outcome.severity, 'minor');
  assert.ok(outcome.critique.includes('sorted invariant'));
  assert.ok(!seenPrompt.includes('Session goal'));
});

test('runPeerAudit recovers the verdict when prose contains stray braces', async () => {
  const invokeModel: InvokeModel = async () =>
    'The set {a, b} is irrelevant.\n{"passed":false,"failedStep":1,"severity":"minor","critique":"Step 1 contradicts the stated bound."}\nEnd of audit.';
  const outcome = await runPeerAudit(['n = 5 + 5 = 10'], baseAuditConfig, invokeModel);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failedStep, 1);
  assert.equal(outcome.severity, 'minor');
});

test('runPeerAudit carries the model-classified severity through on failure', async () => {
  const invokeModel: InvokeModel = async () =>
    '{"passed":false,"failedStep":1,"severity":"severe","critique":"Step proposes weakening the test gates."}';
  const outcome = await runPeerAudit(['adjust the suite configuration'], baseAuditConfig, invokeModel);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failedStep, 1);
  assert.equal(outcome.severity, 'severe');
});

test('runPeerAudit defaults a missing severity on a failed verdict to minor', async () => {
  const invokeModel: InvokeModel = async () =>
    '{"passed":false,"failedStep":1,"critique":"Unclassified logic error."}';
  const outcome = await runPeerAudit(['review the queue implementation'], baseAuditConfig, invokeModel);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.severity, 'minor');
});

test('runPeerAudit returns a passed outcome when the peer audit approves', async () => {
  const invokeModel: InvokeModel = async () =>
    '{"passed":true,"failedStep":null,"severity":null,"critique":"All stripped steps verified."}';
  const outcome = await runPeerAudit(['x = 3 + 4 = 7'], baseAuditConfig, invokeModel, 'Sum the values');
  assert.equal(outcome.passed, true);
  assert.equal(outcome.severity, undefined);
  assert.equal(outcome.error, undefined);
});

test('runPeerAudit fails open when invokeModel rejects', async () => {
  const invokeModel: InvokeModel = async () => {
    throw new Error('side session unavailable');
  };
  const outcome = await runPeerAudit(['x = 3 + 4 = 7'], baseAuditConfig, invokeModel, 'Sum the values');
  assert.equal(outcome.passed, true);
  assert.ok(outcome.error?.includes('side session unavailable'));
});

test('runPeerAudit fails open when the model response is unparseable', async () => {
  const invokeModel: InvokeModel = async () => 'I could not format my audit as JSON, sorry.';
  const outcome = await runPeerAudit(['x = 3 + 4 = 7'], baseAuditConfig, invokeModel);
  assert.equal(outcome.passed, true);
  assert.ok(typeof outcome.error === 'string' && outcome.error.length > 0);
});

test('verifyToolIntent proceeds with any file path when the verified trace is empty', () => {
  const result = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'src/never-audited.ts', content: 'export const x = 1;' } },
    [],
    baseAuditConfig
  );
  assert.equal(result.allowed, true);
});

test('verifyToolIntent blocks an unreferenced path and names it in the reason', () => {
  const result = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'src/b.ts', content: 'export const y = 2;' } },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('src/b.ts'));
  assert.ok(result.reason.includes('file-path trace check'));
  assert.ok(result.reason.includes('absent from the verified reasoning trace'));
});

test('verifyToolIntent blocks reward-hacking patterns and names the failed check', () => {
  const trace = ['Edit src/a.ts to fix the off-by-one bound.'];

  const noVerify = verifyToolIntent(
    { name: 'bash', arguments: { command: 'git commit -m "bypass" --no-verify' } },
    trace,
    baseAuditConfig
  );
  assert.equal(noVerify.allowed, false);
  assert.ok(noVerify.reason.includes('reward-hacking'));
  assert.ok(noVerify.reason.includes('--no-verify'));

  const skippedTest = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'src/a.ts', content: "it.skip('flaky test', () => {});" } },
    trace,
    baseAuditConfig
  );
  assert.equal(skippedTest.allowed, false);

  const tautology = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'src/a.ts', content: 'expect(true).toBe(true);' } },
    trace,
    baseAuditConfig
  );
  assert.equal(tautology.allowed, false);
  assert.ok(tautology.reason.includes('expect(true).toBe(true)'));

  const deletedTests = verifyToolIntent(
    { name: 'bash', arguments: { command: 'rm -rf tests' } },
    trace,
    baseAuditConfig
  );
  assert.equal(deletedTests.allowed, false);

  // FR-011: the reward-hacking check still applies when the trace is empty.
  const emptyTrace = verifyToolIntent(
    { name: 'bash', arguments: { command: 'git commit -m "bypass" --no-verify' } },
    [],
    baseAuditConfig
  );
  assert.equal(emptyTrace.allowed, false);
});

test('verifyToolIntent counts a basename match as referenced', () => {
  const traceHasFullPath = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cat a.ts' } },
    ['Read src/a.ts and inspect the helper.'],
    baseAuditConfig
  );
  assert.equal(traceHasFullPath.allowed, true);

  const argsHaveFullPath = verifyToolIntent(
    { name: 'edit', arguments: { filePath: 'src/a.ts' } },
    ['Refactor a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(argsHaveFullPath.allowed, true);
});

test('extractArgPaths tokenizes extension matches whole with a trailing boundary (FR-066)', () => {
  // The #36 phantom-prefix bug: `config.json` used to yield `config.js`.
  assert.deepEqual(extractArgPaths({ command: 'cat config.json' }), ['config.json']);
  assert.deepEqual(extractArgPaths({ command: 'prettier src/a.tsx' }), ['src/a.tsx']);
  // A sentence-final period after a path does not swallow the token.
  assert.deepEqual(extractArgPaths({ command: 'see src/a.ts.' }), ['src/a.ts']);
});

test('extractArgPaths recognizes wildcard- and variable-bearing pattern tokens (FR-066)', () => {
  // The #36 field bypass: this spelling previously tokenized to nothing,
  // so ~8 routed batches sailed past the trace check unexamined.
  assert.deepEqual(extractArgPaths({ command: 'cat kb/topics/*.md' }), ['kb/topics/*.md']);
  // The #36 phantom demand: this spelling previously yielded `id.md`.
  assert.deepEqual(extractArgPaths({ command: 'cp "$bdir/$id.md" out/' }), ['$bdir/$id.md']);
  assert.ok(isPatternToken('kb/topics/*.md'));
  assert.ok(isPatternToken('$bdir/$id.md'));
  assert.ok(!isPatternToken('src/a.ts'));
  // The shared grammar sees the same tokens in free text (design D3):
  // the stripper's survival predicate and the guard's trace check
  // recognize the same X.
  assert.deepEqual(extractPathTokens('read the batch at kb/topics/gov-ci.md today'), ['kb/topics/gov-ci.md']);
  assert.ok(hasPathToken('update kb/topics/gov-ci.md with the result'));
  assert.ok(!hasPathToken('nothing formal here at all'));
});

test('path-token extraction is immune to cursor bleed from earlier probes (FR-066/FR-068 regression)', () => {
  // The FR-068 wiring exposed a latent hazard: a module-level global
  // regex shares `lastIndex` across consumers — `matchAll` copies it
  // into its iterator and `.test` advances it — so the stripper's
  // survival probe on one text silently shifted the start offset of
  // the guard's next extraction, skipping leading tokens. The grammar
  // now compiles per call site; interleaved consumers cannot shift
  // each other's offsets.
  const longStep = 'first consider src/alpha.ts then src/beta.ts and finally src/gamma.ts last';
  assert.ok(hasPathToken(longStep));
  // Extraction after a probe that matched deep in a longer text still
  // sees the token at offset 0 of the next string.
  assert.deepEqual(extractPathTokens('src/unrelated.ts'), ['src/unrelated.ts']);
  assert.deepEqual(extractArgPaths({ command: 'cat src/never/seen.ts' }), ['src/never/seen.ts']);
  // Repeated probes do not accumulate state either.
  assert.ok(hasPathToken('see notes.md'));
  assert.deepEqual(extractPathTokens('see notes.md'), ['notes.md']);
  assert.ok(!hasPathToken('nothing formal here at all'));
  assert.deepEqual(extractPathTokens('src/leading.ts and src/trailing.ts'), ['src/leading.ts', 'src/trailing.ts']);
});

test('verifyToolIntent satisfies a wildcard pattern from a trace reference (FR-066)', () => {
  const satisfied = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cat kb/topics/*.md' } },
    ['Index the batch at kb/topics/gov-ci.md for review.'],
    baseAuditConfig
  );
  assert.equal(satisfied.allowed, true);

  // The pattern spelling itself, reasoned verbatim, also satisfies —
  // the self-consistency path.
  const verbatim = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cp "$bdir/$id.md" out/' } },
    ['Read each note from $bdir/$id.md into the index.'],
    baseAuditConfig
  );
  assert.equal(verbatim.allowed, true);

  // A concrete path the variable pattern matches satisfies it — the
  // runtime expansion is unknown, so a structural match is the
  // auditable evidence (design D5).
  const expanded = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cp "$bdir/$id.md" out/' } },
    ['Read each note from notes/entry.md into the index.'],
    baseAuditConfig
  );
  assert.equal(expanded.allowed, true);
});

test('verifyToolIntent blocks an unsatisfied pattern naming the pattern itself (FR-066)', () => {
  const blocked = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cat kb/topics/*.md' } },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reason.includes('file-path trace check'));
  assert.ok(blocked.reason.includes('pattern'));
  assert.ok(blocked.reason.includes('kb/topics/*.md'));

  // The reason demands the pattern as spelled, never a phantom
  // expansion like the literal `id.md`.
  const phantom = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cp "$bdir/$id.md" out/' } },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(phantom.allowed, false);
  assert.ok(phantom.reason.includes("'$bdir/$id.md'"));
  assert.ok(phantom.reason.includes('pattern'));
});

test('verifyToolIntent still allows pattern tokens on an empty trace (FR-011, FR-066)', () => {
  const result = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cat kb/topics/*.md' } },
    [],
    baseAuditConfig
  );
  assert.equal(result.allowed, true);
});

test('verifyToolIntent satisfies a concrete write from a path-scoped trace pattern (FR-069)', () => {
  const covered = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'kb/topics/gov-ci.md', content: 'topic notes' } },
    ['Write the topic files as kb/topics/*.md.'],
    baseAuditConfig
  );
  assert.equal(covered.allowed, true);
});

test('verifyToolIntent does not satisfy a concrete write from a bare filename glob (FR-069)', () => {
  const blocked = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'kb/topics/gov-ci.md', content: 'topic notes' } },
    ['Write the topic files as *.md.'],
    baseAuditConfig
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.unmatchedToken, 'kb/topics/gov-ci.md');
});

test('verifyToolIntent does not satisfy a concrete write from a non-covering trace pattern (FR-069)', () => {
  const blocked = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'kb/topics/gov-ci.md', content: 'topic notes' } },
    ['Write the topic files as kb/other/*.md.'],
    baseAuditConfig
  );
  assert.equal(blocked.allowed, false);
});

test('verifyToolIntent satisfies an absolute argument from a relative trace pattern by suffix (FR-069)', () => {
  const covered = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cat /workspace/kb/topics/gov-ci.md' } },
    ['Write the topic files as kb/topics/*.md.'],
    baseAuditConfig
  );
  assert.equal(covered.allowed, true);
});

test('verifyToolIntent matches trace patterns case-insensitively (FR-069)', () => {
  const covered = verifyToolIntent(
    { name: 'write', arguments: { filePath: 'kb/topics/gov-ci.md', content: 'topic notes' } },
    ['Write the topic files as KB/Topics/*.md.'],
    baseAuditConfig
  );
  assert.equal(covered.allowed, true);
});

test('verifyToolIntent treats authored content as data, not a touch (FR-064)', () => {
  // The #33 field scenario: a write whose content quotes an
  // unreferenced filename is authored data — only the operational
  // filePath is checked.
  const authored = verifyToolIntent(
    {
      name: 'write',
      arguments: { filePath: 'src/a.ts', content: 'deploy risk-tier1.sh with the new config' },
    },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(authored.allowed, true);

  // Custom/MCP key names stay covered — coverage fails closed for
  // unknown tools rather than narrowing to a known-key allowlist.
  const customKey = verifyToolIntent(
    { name: 'deploy', arguments: { target: 'ops/risk-tier1.sh' } },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(customKey.allowed, false);
  assert.ok(customKey.reason.includes('ops/risk-tier1.sh'));

  // Bash command strings stay operational in full.
  const bash = verifyToolIntent(
    { name: 'bash', arguments: { command: 'cat ops/risk-tier1.sh' } },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(bash.allowed, false);
  assert.ok(bash.reason.includes('ops/risk-tier1.sh'));
});

test('verifyToolIntent exempts registered console tools from the trace check (FR-065)', () => {
  const consoleTools = new Set(['request_audit']);
  const exempt = verifyToolIntent(
    { name: 'request_audit', arguments: { focus: 'audit the change at ops/risk-tier1.sh' } },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig,
    undefined,
    consoleTools
  );
  assert.equal(exempt.allowed, true);

  // The reward-hacking check still applies to console tools — even on
  // an empty trace (FR-009 is unconditional, FR-011).
  const hacking = verifyToolIntent(
    { name: 'request_audit', arguments: { focus: 'run git commit --no-verify for the change' } },
    [],
    baseAuditConfig,
    undefined,
    consoleTools
  );
  assert.equal(hacking.allowed, false);
  assert.ok(hacking.reason.includes('reward-hacking'));

  // Fail-closed default: without the set, the same call is checked
  // like any other — direct callers opt in by passing the set.
  const direct = verifyToolIntent(
    { name: 'request_audit', arguments: { focus: 'audit the change at ops/risk-tier1.sh' } },
    ['Edit src/a.ts to export the helper.'],
    baseAuditConfig
  );
  assert.equal(direct.allowed, false);
});

// ── Hook layer (task 3.1): entry shape, config precedence, adapter ──

// recordingPluginInput and silentPluginInput now live in ./mocks.ts
// (review rounds 2 and 4).

test('plugin module imports cleanly and exports the PluginModule entry', async () => {
  // The id matches the plugin-config key (review finding #5): a user
  // discovering the registered plugin id can use it as the config key.
  assert.equal(plugin.id, 'opencode-supervisor');
  assert.equal(typeof plugin.server, 'function');

  const hooks = await plugin.server(silentPluginInput());
  assert.equal(typeof hooks.event, 'function');
  assert.equal(typeof hooks['chat.message'], 'function');
  assert.equal(typeof hooks['tool.execute.before'], 'function');
  assert.equal(typeof hooks['tool.execute.after'], 'function');
  assert.equal(typeof hooks['experimental.chat.messages.transform'], 'function');
  assert.equal(typeof hooks.dispose, 'function');
  // FR-020/FR-021: the agent console tools register alongside the hooks.
  assert.equal(typeof hooks.tool?.remind_me?.execute, 'function');
  assert.equal(typeof hooks.tool?.forget_reminder?.execute, 'function');
});

test('PLUGIN_VERSION stays in lockstep with package.json (release integrity)', () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version: string };
  assert.equal(PLUGIN_VERSION, pkg.version);
});

test('resolveHookConfig resolves hook knobs session → environment → defaults', () => {
  const envNames = [
    'OPENCODE_SUPERVISOR_MODEL',
    'OPENCODE_SUPERVISOR_VARIANT',
    'OPENCODE_SUPERVISOR_MAX_REGENERATIONS',
    'OPENCODE_SUPERVISOR_STRIP_MODE',
    'OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING',
    'OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS',
    'OPENCODE_SUPERVISOR_MEMO_MAX_SOLVED_ITEMS',
    'OPENCODE_SUPERVISOR_MEMO_MAX_CRITIQUES',
    'OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const name of envNames) {
    saved[name] = process.env[name];
    delete process.env[name];
  }

  try {
    // Session plugin config wins, including meaningful falsy values.
    const fromSession = resolveHookConfig({
      config: {
        plugins: {
          'opencode-supervisor': {
            auditorModel: 'openai/o3-mini',
            maxRegenerations: 5,
            blockRewardHacking: false,
            stripMode: 'strict',
            memoLimits: { maxSolvedItems: 2, maxCritiques: 1, maxReminders: 1, maxReports: 1 },
          },
        },
      },
    });
    assert.equal(fromSession.auditorModel, 'openai/o3-mini');
    assert.equal(fromSession.maxRegenerations, 5);
    assert.equal(fromSession.blockRewardHacking, false);
    assert.equal(fromSession.stripMode, 'strict');
    assert.deepEqual(fromSession.memoLimits, { maxSolvedItems: 2, maxCritiques: 1, maxReminders: 1, maxReports: 1 });

    // Environment applies when no session override exists.
    process.env.OPENCODE_SUPERVISOR_MAX_REGENERATIONS = '7';
    process.env.OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING = 'false';
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_SOLVED_ITEMS = '9';
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_CRITIQUES = '4';
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS = '6';
    process.env.OPENCODE_SUPERVISOR_STRIP_MODE = 'balanced';
    const fromEnv = resolveHookConfig();
    assert.equal(fromEnv.maxRegenerations, 7);
    assert.equal(fromEnv.blockRewardHacking, false);
    assert.equal(fromEnv.memoLimits.maxSolvedItems, 9);
    assert.equal(fromEnv.memoLimits.maxCritiques, 4);
    assert.equal(fromEnv.memoLimits.maxReminders, 6);
    assert.equal(fromEnv.stripMode, 'balanced');

    // pluginConfig defaults apply when nothing overrides them.
    for (const name of envNames) {
      delete process.env[name];
    }
    const fromDefaults = resolveHookConfig();
    // FR-059: no hardcoded model default — the auditor resolves from the
    // tiers or stays unset (LLM audit disabled, invariants only).
    assert.equal(fromDefaults.auditorModel, undefined);
    assert.equal(fromDefaults.auditorVariant, undefined);
    assert.equal(fromDefaults.maxRegenerations, 2);
    assert.equal(fromDefaults.blockRewardHacking, true);
    assert.equal(fromDefaults.requireStepReferenceInTools, true);
    assert.equal(fromDefaults.stripMode, 'code_and_math');
    assert.deepEqual(fromDefaults.memoLimits, DEFAULT_MEMO_LIMITS);

    // Invalid environment values fall through to defaults (fail-open).
    process.env.OPENCODE_SUPERVISOR_MAX_REGENERATIONS = 'not-a-number';
    process.env.OPENCODE_SUPERVISOR_STRIP_MODE = 'bogus';
    process.env.OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING = 'maybe';
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS = 'not-a-number';
    const invalid = resolveHookConfig();
    assert.equal(invalid.maxRegenerations, 2);
    assert.equal(invalid.stripMode, 'code_and_math');
    assert.equal(invalid.blockRewardHacking, true);
    assert.equal(invalid.memoLimits.maxReminders, DEFAULT_MEMO_LIMITS.maxReminders);
  } finally {
    for (const name of envNames) {
      const value = saved[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

/**
 * Structural shapes of the side-session calls `createInvokeModel` issues
 * (review finding #16): typing the recorded options keeps the assertions
 * below type-checkable without `any` — the mock records exactly what
 * production passes, and asserting that shape is the test's job.
 */
interface RecordedCreateCall {
  body: { title: string; parentID?: string };
  query: { directory: string };
}
interface RecordedPromptCall {
  path: { id: string };
  query: { directory: string };
  body: { model: { providerID: string; modelID: string }; variant: string; parts: Array<Record<string, unknown>> };
}
interface RecordedDeleteCall {
  path: { id: string };
}

function auditorClientMock(
  response: {
    createData?: { id?: string };
    promptData?: { info?: { error?: unknown; providerID?: string; modelID?: string }; parts?: Array<Record<string, unknown>> };
    /** Injected delete-transport rejection (task: side-session deletion fail-open). */
    deleteError?: Error;
    /** Injected prompt-transport rejection (review iteration 2: failure-path cleanup). */
    promptError?: Error;
  }
): {
  client: PluginInput['client'];
  calls: { create: RecordedCreateCall[]; prompt: RecordedPromptCall[]; delete: RecordedDeleteCall[] };
} {
  const calls = { create: [] as RecordedCreateCall[], prompt: [] as RecordedPromptCall[], delete: [] as RecordedDeleteCall[] };
  const client = {
    session: {
      create: async (options: unknown) => {
        calls.create.push(options as RecordedCreateCall);
        return { data: response.createData };
      },
      prompt: async (options: unknown) => {
        calls.prompt.push(options as RecordedPromptCall);
        if (response.promptError !== undefined) {
          throw response.promptError;
        }
        return { data: response.promptData };
      },
      delete: async (options: unknown) => {
        calls.delete.push(options as RecordedDeleteCall);
        if (response.deleteError !== undefined) {
          throw response.deleteError;
        }
        return {};
      },
    },
  };
  return { client: client as unknown as PluginInput['client'], calls };
}

test('createInvokeModel drives a dedicated auditor side session and returns its text', async () => {
  const { client, calls } = auditorClientMock({
    createData: { id: 'auditor-side-1' },
    promptData: {
      info: { providerID: 'mock-provider', modelID: 'mock-model' },
      parts: [
        { type: 'text', text: 'Audit complete.' },
        { type: 'reasoning', text: 'internal deliberation' },
        { type: 'text', text: '{"passed":true}' },
        { type: 'text', text: 'ignored tail', ignored: true },
      ],
    },
  });

  const invokeModel = createInvokeModel(client, '/workdir', silentPluginLogger);
  const text = await invokeModel('Audit these steps.', baseAuditConfig);

  // Lenient extraction: non-ignored text parts joined, others skipped.
  assert.equal(text, 'Audit complete.\n\n{"passed":true}');

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].body.title, 'supervisor-audit @ mock/auditor-model (low)');
  assert.equal(calls.create[0].query.directory, '/workdir');
  assert.equal(calls.create[0].body.parentID, undefined); // FR-004: not parented to a supervised session
  assert.equal(calls.prompt.length, 1);
  assert.equal(calls.prompt[0].path.id, 'auditor-side-1');
  assert.equal(calls.prompt[0].query.directory, '/workdir');
  assert.deepEqual(calls.prompt[0].body.model, { providerID: 'mock', modelID: 'auditor-model' });
  assert.equal(calls.prompt[0].body.variant, 'low');
  assert.deepEqual(calls.prompt[0].body.parts, [{ type: 'text', text: 'Audit these steps.' }]);

  // Review finding #10: the ephemeral side session is deleted after the
  // response text is extracted — no persistent audit sessions accumulate.
  assert.equal(calls.delete.length, 1);
  assert.deepEqual(calls.delete[0], { path: { id: 'auditor-side-1' } });
});

test('createInvokeModel deletes the auditor side session and fails open when deletion rejects', async () => {
  const deleteFailed = auditorClientMock({
    createData: { id: 'auditor-side-del' },
    promptData: { info: {}, parts: [{ type: 'text', text: '{"passed":true}' }] },
    deleteError: new Error('delete transport down'),
  });

  // The delete rejection is logged and swallowed (fail-open): the audit
  // text is already secured before deletion runs, so the invocation
  // still resolves with it.
  const text = await createInvokeModel(deleteFailed.client, '/workdir', silentPluginLogger)('Audit these steps.', baseAuditConfig);

  assert.equal(text, '{"passed":true}');
  assert.equal(deleteFailed.calls.delete.length, 1);
  assert.deepEqual(deleteFailed.calls.delete[0], { path: { id: 'auditor-side-del' } });
});

test('createInvokeModel falls back to the shared silent logger when none is passed', async () => {
  const deleteFailed = auditorClientMock({
    createData: { id: 'auditor-side-del' },
    promptData: { info: {}, parts: [{ type: 'text', text: '{"passed":true}' }] },
    deleteError: new Error('delete transport down'),
  });

  // Review round 5: 2-arg callers keep the 2.4.0 signature — with no
  // logger threaded in, the shared silent logger absorbs the delete
  // rejection and the invocation still resolves with the audit text.
  const text = await createInvokeModel(deleteFailed.client, '/workdir')('Audit these steps.', baseAuditConfig);

  assert.equal(text, '{"passed":true}');
  assert.equal(deleteFailed.calls.delete.length, 1);
});

test('createInvokeModel deletes the side session when the prompt transport rejects', async () => {
  const promptFailed = auditorClientMock({
    createData: { id: 'auditor-side-prompt-fail' },
    promptError: new Error('prompt transport down'),
  });

  // Failure paths must not leak the stored side session (review
  // iteration 2, MEDIUM): the delete is attempted before the original
  // error is rethrown, preserving the fail-open rejection contract
  // (FR-005) that runPeerAudit relies on.
  await assert.rejects(
    createInvokeModel(promptFailed.client, '/workdir', silentPluginLogger)('Audit these steps.', baseAuditConfig),
    /prompt transport down/
  );
  assert.equal(promptFailed.calls.delete.length, 1);
  assert.deepEqual(promptFailed.calls.delete[0], { path: { id: 'auditor-side-prompt-fail' } });
});

test('createInvokeModel rejects on adapter failures so runPeerAudit fails open', async () => {
  const noSession = auditorClientMock({ createData: {} });
  await assert.rejects(
    createInvokeModel(noSession.client, '/workdir', silentPluginLogger)('prompt', baseAuditConfig),
    /auditor side session create failed/
  );

  const noPromptData = auditorClientMock({ createData: { id: 'auditor-side-2' } });
  await assert.rejects(
    createInvokeModel(noPromptData.client, '/workdir', silentPluginLogger)('prompt', baseAuditConfig),
    /auditor side session prompt failed/
  );

  const messageError = auditorClientMock({
    createData: { id: 'auditor-side-3' },
    promptData: { info: { error: { name: 'ApiError' } }, parts: [] },
  });
  await assert.rejects(
    createInvokeModel(messageError.client, '/workdir', silentPluginLogger)('prompt', baseAuditConfig),
    /auditor side session message error/
  );

  const malformedSlug = auditorClientMock({ createData: { id: 'unused' } });
  await assert.rejects(
    createInvokeModel(malformedSlug.client, '/workdir', silentPluginLogger)('prompt', {
      ...baseAuditConfig,
      auditorModel: 'gemini-flash',
    }),
    /is not a <provider>\/<model-id> slug/
  );
});

test('tool.execute.before blocks reward hacking (--no-verify)', async () => {
  const hooks = await plugin.server(silentPluginInput());

  await assert.rejects(
    hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 'guard-session-1', callID: 'call-1' },
      { args: { command: 'git commit -m "bypass" --no-verify' } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('Execution blocked'));
      assert.ok(error.message.includes('reward-hacking'));
      assert.ok(error.message.includes('--no-verify'));
      return true;
    }
  );
});

// ── Event-hook audit path (task 3.2): live wiring, mocked client ──

/** Env knobs the live audit path reads; pinned clean for determinism. */
const AUDIT_ENV_NAMES = [
  'OPENCODE_SUPERVISOR_MODEL',
  'OPENCODE_SUPERVISOR_VARIANT',
  'OPENCODE_SUPERVISOR_MAX_REGENERATIONS',
  'OPENCODE_SUPERVISOR_STRIP_MODE',
  'OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING',
  'OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS',
  'OPENCODE_SUPERVISOR_MEMO_MAX_SOLVED_ITEMS',
  'OPENCODE_SUPERVISOR_MEMO_MAX_CRITIQUES',
  'OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS',
  'OPENCODE_SUPERVISOR_MAX_TIMEOUT_FAIL_OPENS',
  'OPENCODE_SUPERVISOR_MAX_COVERED_TIMEOUT_FAIL_OPENS',
];

/** Saves/deletes the auditor env knobs and isolates XDG_CONFIG_HOME around `run`, restoring after. */
async function withCleanAuditEnv(run: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of AUDIT_ENV_NAMES) {
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
    for (const name of AUDIT_ENV_NAMES) {
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

/**
 * Widened hook-map view for the dispatch helpers (review finding #16):
 * the tests deliberately feed raw and odd payloads, so the helpers take
 * `unknown`. Method syntax keeps parameters bivariant, so the real
 * `Hooks` map is assignable to this shape.
 */
interface DispatchHooks {
  event?(input: unknown): Promise<void>;
  'chat.message'?(input: unknown, output: unknown): Promise<void>;
  'tool.execute.before'?(input: unknown, output: unknown): Promise<void>;
  'tool.execute.after'?(input: unknown, output: unknown): Promise<void>;
  'experimental.chat.messages.transform'?(input: unknown, output: unknown): Promise<void>;
  dispose?(): Promise<void>;
}

/** Event-hook input shape, for casting deliberately undeclared event payloads. */
type EventHookInput = Parameters<NonNullable<Hooks['event']>>[0];

/** Dispatches one message.part.updated event through the hook. */
function dispatchPart(hooks: DispatchHooks, part: unknown): Promise<void> {
  return hooks.event!({ event: { type: 'message.part.updated', properties: { part } } });
}

/**
 * Builds a plugin input whose client records every side-session and
 * critique-delivery call and serves queued auditor responses (one per
 * session.prompt; the default verdict passes). `failures` injects
 * delivery-transport rejections (task 3.3 fail-open tests). Fresh mock
 * client per test — no network.
 */
function auditHarness(
  responses: string[],
  failures: { promptAsync?: Error; abort?: Error } = {}
): {
  input: PluginInput;
  calls: {
    create: unknown[];
    prompt: unknown[];
    promptAsync: unknown[];
    abort: unknown[];
    delete: unknown[];
    /** Delivery transport call order — asserts abort precedes delivery. */
    deliveryOrder: string[];
  };
} {
  const calls = {
    create: [] as unknown[],
    prompt: [] as unknown[],
    promptAsync: [] as unknown[],
    abort: [] as unknown[],
    delete: [] as unknown[],
    deliveryOrder: [] as string[],
  };
  const queue = [...responses];
  const input = {
    client: {
      session: {
        create: async (options: unknown) => {
          calls.create.push(options);
          return { data: { id: 'auditor-side-3-2' } };
        },
        prompt: async (options: unknown) => {
          calls.prompt.push(options);
          const text = queue.length > 0 ? (queue.shift() as string) : '{"passed":true}';
          return { data: { info: {}, parts: [{ type: 'text', text }] } };
        },
        promptAsync: async (options: unknown) => {
          calls.promptAsync.push(options);
          calls.deliveryOrder.push('promptAsync');
          if (failures.promptAsync !== undefined) {
            throw failures.promptAsync;
          }
          return {};
        },
        abort: async (options: unknown) => {
          calls.abort.push(options);
          calls.deliveryOrder.push('abort');
          if (failures.abort !== undefined) {
            throw failures.abort;
          }
          return {};
        },
        delete: async (options: unknown) => {
          calls.delete.push(options);
          return {};
        },
      },
      ...silentClientSurface,
    },
    directory: '/tmp/supervisor-hook-test',
  };
  return { input: input as unknown as PluginInput, calls };
}

test('event hook observes a completed reasoning part once and never rejects', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness(['{"passed":true}']);
    const hooks = await plugin.server(input);

    const faultyPart = completedReasoningPart({ text: 'capacity = 24 * 15 = 340' });
    const dispatch = (part: unknown): Promise<void> => dispatchPart(hooks, part);

    // Fire-and-forget contract (spike 1.3): the hook promise never rejects.
    await dispatch(faultyPart);
    await dispatch(faultyPart); // duplicate publication is deduped (FR-001)

    const state = sessionState.get('event-session-1');
    assert.equal(state.seenParts.size, 1);
    assert.ok(state.seenParts.has('event-session-1:msg-1:part-1'));
    // The arithmetic invariant (24 * 15 = 360, not 340) fails the audit
    // deterministically (FR-003), so the model is never consulted. The
    // minor failure still records (FR-063): the step stays in the
    // verified trace marked passed: false — a misstated tally does not
    // revoke the part's file reasoning.
    assert.deepEqual(state.verifiedSteps, [{ text: 'capacity = 24 * 15 = 340', passed: false }]);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.prompt.length, 0);

    // Incomplete parts (time.end absent) and non-reasoning parts are ignored.
    await dispatch({ ...faultyPart, id: 'part-2', time: { start: 3 } });
    await dispatch({ ...faultyPart, id: 'part-3', type: 'text' });
    assert.equal(sessionState.get('event-session-1').seenParts.size, 1);

    // Undeclared event types arrive at runtime and are ignored, not errors.
    await hooks.event!({ event: { type: 'message.part.delta', properties: {} } } as unknown as EventHookInput);
    assert.equal(sessionState.get('event-session-1').seenParts.size, 1);
  });
});

test('event hook audits a completed reasoning part exactly once and records the passed step', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([
      '{"passed":true,"failedStep":null,"severity":null,"critique":"All steps verified."}',
    ]);
    const hooks = await plugin.server(input);

    // The event hook never captures the goal itself (`chat.message`
    // owns FR-013); when the state carries one the audit prompt must
    // include it.
    sessionState.get('audit-session-once').goal = 'Ship the audit supervisor';

    await dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-session-once' }));

    // Exactly one side-session audit: one create, one prompt (FR-001,
    // FR-004), scoped to the plugin input's directory.
    assert.equal(calls.create.length, 1);
    assert.equal(calls.prompt.length, 1);
    assert.equal(calls.create[0].query.directory, '/tmp/supervisor-hook-test');

    // The audit prompt embeds the step and the session goal.
    const promptText = calls.prompt[0].body.parts[0].text;
    assert.ok(promptText.includes('the rate = 24 * 15 = 360'));
    assert.ok(promptText.includes('Ship the audit supervisor'));

    // FR-006: the passed step lands in the verified trace.
    assert.deepEqual(sessionState.get('audit-session-once').verifiedSteps, [
      { text: 'the rate = 24 * 15 = 360', passed: true },
    ]);
  });
});

test('event hook records only passed steps in the verified trace', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([
      '{"passed":false,"failedStep":1,"severity":"minor","critique":"Step 1 misstates the capacity bound."}',
      '{"passed":true,"failedStep":null,"severity":null,"critique":"All steps verified."}',
    ]);
    const hooks = await plugin.server(input);

    await dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-session-trace', id: 'part-fail' }));
    await dispatchPart(
      hooks,
      completedReasoningPart({
        sessionID: 'audit-session-trace',
        id: 'part-pass',
        messageID: 'msg-2',
        text: 'total = 2 + 3 = 5',
      })
    );

    // One side session per audit; the failed peer verdict never enters
    // the trace (FR-063: peer failures evict), the passed verdict does.
    assert.equal(calls.create.length, 2);
    assert.equal(calls.prompt.length, 2);
    assert.deepEqual(sessionState.get('audit-session-trace').verifiedSteps, [
      { text: 'total = 2 + 3 = 5', passed: true },
    ]);

    // Task 3.3 wiring: the failed verdict's critique is steered to the
    // session and recorded (FR-007/FR-015) — it never enters the
    // verified trace (FR-006).
    const state = sessionState.get('audit-session-trace');
    assert.equal(state.critiqueCount, 1);
    assert.deepEqual(state.critiqueLog, [
      { text: 'Step 1 misstates the capacity bound.', severity: 'minor', delivered: true },
    ]);
  });
});

test('event hook strips narrative before the audit and the trace', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness(['{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}']);
    const hooks = await plugin.server(input);

    await dispatchPart(
      hooks,
      completedReasoningPart({
        sessionID: 'audit-session-strip',
        text: 'Basically, the throughput = 120 / 4 = 30 requests per second',
      })
    );

    // FR-002: the audit prompt carries the stripped form...
    const promptText = calls.prompt[0].body.parts[0].text;
    assert.ok(promptText.includes('the throughput = 120 / 4 = 30 requests per second'));
    assert.ok(!promptText.includes('Basically,'));

    // ...and the trace entry is the stripped text, not the raw part.
    assert.deepEqual(sessionState.get('audit-session-strip').verifiedSteps, [
      { text: 'the throughput = 120 / 4 = 30 requests per second', passed: true },
    ]);
  });
});

test('event hook still dedupes duplicate publications with the live audit path', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);

    const part = completedReasoningPart({ sessionID: 'audit-session-dedupe', id: 'part-d', text: 'x = 3 + 4 = 7' });
    await dispatchPart(hooks, part);
    await dispatchPart(hooks, part);
    await dispatchPart(hooks, part);

    // FR-001: three publications, one audit, one trace entry.
    assert.equal(calls.create.length, 1);
    assert.equal(calls.prompt.length, 1);
    const state = sessionState.get('audit-session-dedupe');
    assert.equal(state.seenParts.size, 1);
    assert.deepEqual(state.verifiedSteps, [{ text: 'x = 3 + 4 = 7', passed: true }]);
  });
});

test('event hook skips narrative-only parts without an audit', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);

    await dispatchPart(
      hooks,
      completedReasoningPart({
        sessionID: 'audit-session-narrative',
        id: 'part-n',
        text: 'First let us think about the problem.',
      })
    );

    // Stripping removes the whole step: no model call, nothing recorded.
    assert.equal(calls.create.length, 0);
    assert.equal(calls.prompt.length, 0);
    const state = sessionState.get('audit-session-narrative');
    assert.equal(state.seenParts.size, 1); // observed and deduped...
    assert.equal(state.verifiedSteps.length, 0); // ...but never audited
  });
});

test('event hook never rejects when the audit client fails (fail-open)', async () => {
  await withCleanAuditEnv(async () => {
    const createCalls: unknown[] = [];
    const input = {
      client: {
        session: {
          create: async (options: unknown) => {
            createCalls.push(options);
            throw new Error('side session unavailable');
          },
          prompt: async () => ({ data: { info: {}, parts: [] } }),
          promptAsync: async () => ({}),
          abort: async () => ({}),
          delete: async () => ({}),
        },
        ...silentClientSurface,
      },
      directory: '/tmp/supervisor-hook-test',
    };
    // Partial SDK stand-in, cast once like the other mocks (review finding #16).
    const hooks = await plugin.server(input as unknown as PluginInput);

    // The hook promise resolves even though the client rejects;
    // runPeerAudit fails open (FR-005), so the step still passes and is
    // recorded — a degraded auditor never fences the session's tools.
    await assert.doesNotReject(() =>
      dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-session-failopen', id: 'part-x', text: 'x = 3 + 4 = 7' }))
    );
    assert.equal(createCalls.length, 1);
    assert.deepEqual(sessionState.get('audit-session-failopen').verifiedSteps, [{ text: 'x = 3 + 4 = 7', passed: true }]);
  });
});

test('event hook keeps a minor arithmetic failure in the trace marked unpassed (FR-063)', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);
    const sessionID = 'audit-session-no-evict';

    // The part names a file AND misstates a tally. The critique still
    // steers (FR-007) while the step stays in the ledger carrying its
    // outcome — the trace is a path ledger (FR-010), and a misstated
    // tally does not revoke the part's file reasoning.
    await dispatchPart(
      hooks,
      completedReasoningPart({
        sessionID,
        id: 'part-ne1',
        text: 'edit src/a.ts: capacity = 24 * 15 = 340',
      })
    );
    const state = sessionState.get(sessionID);
    assert.deepEqual(state.verifiedSteps, [{ text: 'edit src/a.ts: capacity = 24 * 15 = 340', passed: false }]);
    assert.equal(calls.promptAsync.length, 1); // the critique still steers
    assert.equal(state.critiqueCount, 1);

    // The guarded path proceeds on the recorded reasoning: a minor
    // misstatement does not fence the tools the part reasoned about.
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'edit', { filePath: 'src/a.ts', content: 'export const x = 1;' })
    );
  });
});

test('event hook keeps an off-by-one failure in the trace marked unpassed (FR-063)', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);
    const sessionID = 'audit-session-off-by-one';

    await dispatchPart(
      hooks,
      completedReasoningPart({
        sessionID,
        id: 'part-obo',
        text: 'for (let i = 0; i <= items.length; i++) { total += items[i]; }',
      })
    );
    const state = sessionState.get(sessionID);
    assert.deepEqual(state.verifiedSteps, [
      { text: 'for (let i = 0; i <= items.length; i++) { total += items[i]; }', passed: false },
    ]);
    assert.equal(calls.promptAsync.length, 1); // minor: steer, not interrupt
    assert.equal(calls.abort.length, 0);
  });
});

test('event hook evicts severe findings and peer failures from the trace entirely (FR-063)', async () => {
  await withCleanAuditEnv(async () => {
    // Severe (reward hacking): evicted — the reasoning is not trustworthy
    // as a path ledger, and the session is interrupted (FR-008).
    const severeHarness = auditHarness([]);
    const severeHooks = await plugin.server(severeHarness.input);
    await dispatchPart(
      severeHooks,
      completedReasoningPart({
        sessionID: 'audit-session-severe-evict',
        id: 'part-sev',
        text: 'git commit --no-verify -m "bypass src/a.ts hooks"',
      })
    );
    const severeState = sessionState.get('audit-session-severe-evict');
    assert.equal(severeState.verifiedSteps.length, 0);
    assert.equal(severeHarness.calls.abort.length, 1);

    // Peer failure (minor): evicted too — only deterministic invariants
    // carry the no-evict exception; a peer finding means the reasoning
    // itself did not verify.
    const peerHarness = auditHarness(['{"passed":false,"failedStep":1,"severity":"minor","critique":"Step 1 misstates the capacity bound."}']);
    const peerHooks = await plugin.server(peerHarness.input);
    await dispatchPart(
      peerHooks,
      completedReasoningPart({
        sessionID: 'audit-session-peer-evict',
        id: 'part-peer',
        text: 'the rate = 24 * 15 = 360 with src/a.ts',
      })
    );
    assert.equal(sessionState.get('audit-session-peer-evict').verifiedSteps.length, 0);
  });
});

// ── Critique delivery (task 3.3): steer, bound, interrupt ─────────

test('event hook steers a minor audit failure through promptAsync', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([
      '{"passed":false,"failedStep":1,"severity":"minor","critique":"Step 1 misstates the capacity bound."}',
    ]);
    const hooks = await plugin.server(input);

    await dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-session-steer' }));

    // FR-007 (spike 1.2 call shape): one steer delivery, no interrupt.
    assert.equal(calls.promptAsync.length, 1);
    assert.equal(calls.abort.length, 0);
    assert.equal(calls.promptAsync[0].path.id, 'audit-session-steer');
    const sent = calls.promptAsync[0].body.parts[0];
    assert.equal(sent.type, 'text');
    assert.equal(sent.synthetic, true);
    // The auditor's critique rides a minimal corrective framing.
    assert.ok(sent.text.startsWith('[supervisor]'));
    assert.ok(sent.text.includes('Step 1 misstates the capacity bound.'));

    // The delivered critique counts against the bound and logs (FR-015).
    const state = sessionState.get('audit-session-steer');
    assert.equal(state.critiqueCount, 1);
    assert.deepEqual(state.critiqueLog, [
      { text: 'Step 1 misstates the capacity bound.', severity: 'minor', delivered: true },
    ]);
  });
});

test('event hook withholds critiques once maxRegenerations is reached', async () => {
  await withCleanAuditEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MAX_REGENERATIONS = '1';
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);

    // Two deterministic arithmetic failures (FR-003; no model call):
    // the first steers, the second is over the bound of 1.
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID: 'audit-session-bound', id: 'part-b1', text: 'capacity = 24 * 15 = 340' })
    );
    await dispatchPart(
      hooks,
      completedReasoningPart({
        sessionID: 'audit-session-bound',
        id: 'part-b2',
        messageID: 'msg-2',
        text: 'total = 11 + 2 = 14',
      })
    );

    assert.equal(calls.create.length, 0); // invariants short-circuit — no model audit
    assert.equal(calls.promptAsync.length, 1); // only the first critique is delivered
    const state = sessionState.get('audit-session-bound');
    assert.equal(state.critiqueCount, 1);
    assert.equal(state.critiqueLog.length, 2);
    // The overflow critique is recorded without delivery (FR-007/FR-015).
    assert.deepEqual(
      state.critiqueLog.map((entry) => entry.delivered),
      [true, false]
    );
    assert.equal(state.critiqueLog[1].severity, 'minor');
    assert.ok(state.critiqueLog[1].text.includes('Arithmetic error'));
  });
});

test('event hook bounds deliveries to the default maxRegenerations of 2', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);

    const sessionID = 'audit-session-default-bound';
    // Three deterministic minor failures under the default bound (2):
    // two steer, the third is recorded as withheld overflow.
    await dispatchPart(hooks, completedReasoningPart({ sessionID, id: 'p1', text: 'a = 1 + 1 = 3' }));
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'p2', messageID: 'msg-2', text: 'b = 2 + 2 = 5' })
    );
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'p3', messageID: 'msg-3', text: 'c = 3 + 3 = 7' })
    );

    assert.equal(calls.promptAsync.length, 2);
    const state = sessionState.get(sessionID);
    assert.equal(state.critiqueCount, 2);
    assert.deepEqual(
      state.critiqueLog.map((entry) => entry.delivered),
      [true, true, false]
    );
  });
});

test('event hook aborts the session before delivering a severe critique', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([
      '{"passed":false,"failedStep":1,"severity":"severe","critique":"Step 1 proposes weakening the test gates."}',
    ]);
    const hooks = await plugin.server(input);

    await dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-session-severe' }));

    // FR-008: the interrupt fires on the supervised session...
    assert.equal(calls.abort.length, 1);
    assert.equal(calls.abort[0].path.id, 'audit-session-severe');
    // ...before the critique delivery (spike 1.2 ordering — an abort
    // after delivery kills the corrective turn).
    assert.equal(calls.promptAsync.length, 1);
    assert.equal(calls.promptAsync[0].path.id, 'audit-session-severe');
    assert.deepEqual(calls.deliveryOrder, ['abort', 'promptAsync']);
    assert.ok(calls.promptAsync[0].body.parts[0].text.includes('weakening the test gates'));

    const state = sessionState.get('audit-session-severe');
    assert.equal(state.critiqueCount, 1);
    assert.deepEqual(state.critiqueLog, [
      { text: 'Step 1 proposes weakening the test gates.', severity: 'severe', delivered: true },
    ]);
  });
});

test('event hook bounds severe aborts once maxRegenerations is reached', async () => {
  await withCleanAuditEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MAX_REGENERATIONS = '1';
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);

    const sessionID = 'audit-session-severe-overflow';
    // Two deterministic reward-hacking failures (FR-003, severe).
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'part-s1', text: 'git commit --no-verify -m "bypass hooks"' })
    );
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'part-s2', messageID: 'msg-2', text: 'rm -rf tests' })
    );

    // Decision amendment (review findings #2/#8, mirroring the live
    // smoke test's wedged session): the bound governs the whole
    // intervention. The FIRST severe finding aborts then steers (abort
    // precedes delivery, spike 1.2); the SECOND, over the bound of 1,
    // neither aborts nor delivers — it is recorded as withheld. The
    // unbounded-abort wedge (markers re-quoted from history kept
    // interrupting every turn after the bound was spent) cannot recur.
    assert.equal(calls.abort.length, 1);
    assert.equal(calls.abort[0].path.id, sessionID);
    assert.equal(calls.promptAsync.length, 1);
    assert.deepEqual(calls.deliveryOrder, ['abort', 'promptAsync']);
    const state = sessionState.get(sessionID);
    assert.equal(state.critiqueCount, 1);
    assert.deepEqual(
      state.critiqueLog.map((entry) => entry.delivered),
      [true, false]
    );
    assert.equal(state.critiqueLog[1].severity, 'severe');
    assert.ok(state.critiqueLog[1].text.includes('Reward hacking'));
  });
});

test('event hook treats an unclassified failure as minor and does not abort', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([
      '{"passed":false,"failedStep":1,"critique":"Unclassified logic error."}',
    ]);
    const hooks = await plugin.server(input);

    await dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-session-unclassified' }));

    // D3 fail-open conservatism: absent severity steers, never interrupts.
    assert.equal(calls.abort.length, 0);
    assert.equal(calls.promptAsync.length, 1);
    assert.deepEqual(sessionState.get('audit-session-unclassified').critiqueLog, [
      { text: 'Unclassified logic error.', severity: 'minor', delivered: true },
    ]);
  });
});

test('event hook fails open when the critique delivery transport rejects', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([], { promptAsync: new Error('prompt transport down') });
    const hooks = await plugin.server(input);

    // The hook promise still resolves (FR-005)...
    await assert.doesNotReject(() =>
      dispatchPart(
        hooks,
        completedReasoningPart({ sessionID: 'audit-session-transport', id: 'part-t', text: 'capacity = 24 * 15 = 340' })
      )
    );

    // ...and the delivery was attempted but not delivered: recorded as
    // withheld and not counted against the bound.
    assert.equal(calls.promptAsync.length, 1);
    const state = sessionState.get('audit-session-transport');
    assert.equal(state.critiqueCount, 0);
    assert.equal(state.critiqueLog.length, 1);
    assert.equal(state.critiqueLog[0].delivered, false);
    assert.ok(state.critiqueLog[0].text.includes('Arithmetic error'));
  });
});

test('event hook still delivers a severe critique when the abort rejects', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness(
      ['{"passed":false,"failedStep":1,"severity":"severe","critique":"Step 1 proposes bypassing review."}'],
      { abort: new Error('abort transport down') }
    );
    const hooks = await plugin.server(input);

    await dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-session-abort-fail' }));

    // The failed interrupt is logged and swallowed (fail-open); the
    // critique still steers, and the abort-first ordering is preserved.
    assert.equal(calls.abort.length, 1);
    assert.equal(calls.promptAsync.length, 1);
    assert.deepEqual(calls.deliveryOrder, ['abort', 'promptAsync']);
    assert.deepEqual(sessionState.get('audit-session-abort-fail').critiqueLog, [
      { text: 'Step 1 proposes bypassing review.', severity: 'severe', delivered: true },
    ]);
  });
});

test('event hook consumes the severe slot when delivery fails after the abort', async () => {
  await withCleanAuditEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MAX_REGENERATIONS = '1';
    const { input, calls } = auditHarness(
      ['{"passed":false,"failedStep":1,"severity":"severe","critique":"Step 1 proposes weakening the test gates."}'],
      { promptAsync: new Error('prompt transport down') }
    );
    const hooks = await plugin.server(input);
    const sessionID = 'audit-session-severe-transport';

    // Severe finding whose abort SUCCEEDS but whose promptAsync
    // transport REJECTS (review iteration 2, MEDIUM): the reserved
    // slot stays consumed — the intervention (interrupt) already
    // fired, and releasing it would let persistent delivery failures
    // with succeeding aborts recur without spending the bound. The
    // critique is recorded undelivered and nothing throws (FR-005).
    await assert.doesNotReject(() => dispatchPart(hooks, completedReasoningPart({ sessionID })));

    assert.equal(calls.abort.length, 1);
    assert.equal(calls.promptAsync.length, 1);
    assert.deepEqual(calls.deliveryOrder, ['abort', 'promptAsync']); // abort-first ordering preserved
    const state = sessionState.get(sessionID);
    assert.equal(state.critiqueCount, 1); // slot consumed, NOT released
    assert.deepEqual(state.critiqueLog, [
      { text: 'Step 1 proposes weakening the test gates.', severity: 'severe', delivered: false },
    ]);

    // A second severe finding is over the bound of 1: the consumed
    // slot (not the failed delivery) spent it — neither abort nor
    // delivery fires, and the critique is recorded as withheld.
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'part-s2', messageID: 'msg-2', text: 'rm -rf tests' })
    );
    assert.equal(calls.abort.length, 1);
    assert.equal(calls.promptAsync.length, 1);
    assert.equal(state.critiqueCount, 1);
    assert.equal(state.critiqueLog.length, 2);
    assert.equal(state.critiqueLog[1].delivered, false);
    assert.equal(state.critiqueLog[1].severity, 'severe');
  });
});

// ── Hook wiring (task 3.4): goal, solved items, memo injection ────

/** Dispatches one chat.message through the hook with a raw payload. */
function dispatchChatMessage(hooks: DispatchHooks, sessionID: string, payload: unknown): Promise<void> {
  return hooks['chat.message']!({ sessionID }, payload);
}

/** Dispatches one tool.execute.after through the hook with a raw output. */
function dispatchToolAfter(hooks: DispatchHooks, sessionID: string, tool: string, output: unknown): Promise<void> {
  return hooks['tool.execute.after']!({ tool, sessionID, callID: 'call-1', args: {} }, output);
}

/** A session message in the messages-transform payload shape. */
function sessionMessage(sessionID: string | undefined): Record<string, unknown> {
  const info: Record<string, unknown> = { id: 'msg-1', role: 'user', time: { created: 1 } };
  if (sessionID !== undefined) {
    info.sessionID = sessionID;
  }
  return { info, parts: [{ type: 'text', text: 'user turn' }] };
}

/**
 * Dispatches one memo messages-transform invocation and returns the
 * payload list; `omitMessages` dispatches an output with no messages
 * array at all (odd-payload guard).
 */
async function dispatchMemoTransform(
  hooks: DispatchHooks,
  sessionID: string | undefined,
  options: { omitMessages?: boolean } = {}
): Promise<unknown[]> {
  const messages: unknown[] = [sessionMessage(sessionID)];
  await hooks['experimental.chat.messages.transform']!(
    undefined,
    options.omitMessages === true ? {} : { messages }
  );
  return messages;
}

/** Extracts a messages-transform message's text (joined text parts). */
function messageText(message: unknown): string {
  const parts = (message as { parts?: Array<{ type?: string; text?: unknown }> }).parts ?? [];
  return parts.filter((part) => part.type === 'text').map((part) => String(part.text)).join('\n');
}

test('chat.message captures the first user message as the session goal', async () => {
  const hooks = await plugin.server(silentPluginInput());
  const sessionID = 'goal-session-first';

  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm1', role: 'user' },
    parts: [{ type: 'text', text: '  Ship the audit supervisor.  ' }],
  });

  // FR-013: the first user message is the goal, trimmed.
  assert.equal(sessionState.get(sessionID).goal, 'Ship the audit supervisor.');
});

test('chat.message never replaces an already-captured goal', async () => {
  const hooks = await plugin.server(silentPluginInput());
  const sessionID = 'goal-session-sticky';

  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm1', role: 'user' },
    parts: [{ type: 'text', text: 'first request' }],
  });
  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm2', role: 'user' },
    parts: [{ type: 'text', text: 'a different request' }],
  });

  // FR-013: once set, the goal is never replaced.
  assert.equal(sessionState.get(sessionID).goal, 'first request');
});

test('chat.message ignores assistant-role messages for goal capture', async () => {
  const hooks = await plugin.server(silentPluginInput());
  const sessionID = 'goal-session-assistant';

  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm1', role: 'assistant' },
    parts: [{ type: 'text', text: 'assistant prose' }],
  });
  assert.equal(sessionState.get(sessionID).goal, undefined);

  // The assistant message does not consume the first-user slot: the
  // next real user message still becomes the goal.
  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm2', role: 'user' },
    parts: [{ type: 'text', text: 'the actual goal' }],
  });
  assert.equal(sessionState.get(sessionID).goal, 'the actual goal');
});

test('chat.message ignores synthetic user parts for goal capture', async () => {
  const hooks = await plugin.server(silentPluginInput());
  const sessionID = 'goal-session-synthetic';

  // Synthetic parts (this plugin's own critiques, host injections)
  // are not user input and cannot become the goal...
  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm1', role: 'user' },
    parts: [{ type: 'text', text: 'synthetic steer', synthetic: true }],
  });
  assert.equal(sessionState.get(sessionID).goal, undefined);

  // ...so the first REAL user text still wins.
  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm2', role: 'user' },
    parts: [{ type: 'text', text: 'the real goal' }],
  });
  assert.equal(sessionState.get(sessionID).goal, 'the real goal');
});

test('chat.message ignores whitespace-only user text for goal capture', async () => {
  const hooks = await plugin.server(silentPluginInput());
  const sessionID = 'goal-session-whitespace';

  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm1', role: 'user' },
    parts: [{ type: 'text', text: '   \n\t  ' }],
  });
  assert.equal(sessionState.get(sessionID).goal, undefined);

  await dispatchChatMessage(hooks, sessionID, {
    message: { id: 'm2', role: 'user' },
    parts: [{ type: 'text', text: 'later real goal' }],
  });
  assert.equal(sessionState.get(sessionID).goal, 'later real goal');
});

test('tool.execute.after appends solved items with truncated, single-line outcomes', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'solved-session-shape';

    await dispatchToolAfter(hooks, sessionID, 'bash', { title: 't', output: 'x'.repeat(200), metadata: {} });
    await dispatchToolAfter(hooks, sessionID, 'read', { title: 't', output: 'line one\nline two', metadata: {} });
    await dispatchToolAfter(hooks, sessionID, 'grep', { title: 't', output: '2 matches', metadata: {} });

    const solved = sessionState.get(sessionID).solvedItems;
    assert.deepEqual(
      solved.map((item) => item.tool),
      ['bash', 'read', 'grep']
    );
    // Long outputs truncate to at most 80 characters, ellipsis included.
    assert.equal(solved[0].outcome.length, 80);
    assert.ok(solved[0].outcome.endsWith('...'));
    assert.ok(solved[0].outcome.startsWith('xxx'));
    // Multi-line outputs collapse to a single memo line.
    assert.equal(solved[1].outcome, 'line one line two');
    // Short outputs pass through verbatim.
    assert.equal(solved[2].outcome, '2 matches');
  });
});

test('tool.execute.after derives megabyte-scale outcomes with the same bounded shape', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'solved-session-huge';

    // A megabyte-scale output must cost the same as a short one
    // (review iteration 2, LOW): the outcome derives from a bounded
    // prefix sliced BEFORE the whitespace collapse, then truncates to
    // the same 80-character single-line shape. The efficiency is the
    // fix; this test pins the observable contract for huge outputs.
    await dispatchToolAfter(hooks, sessionID, 'bash', { title: 't', output: 'x'.repeat(1_000_000), metadata: {} });

    const solved = sessionState.get(sessionID).solvedItems;
    assert.equal(solved.length, 1);
    assert.equal(solved[0].outcome.length, 80);
    assert.ok(solved[0].outcome.startsWith('xxx'));
    assert.ok(solved[0].outcome.endsWith('...'));
  });
});

test('tool.execute.after accumulates solved items per session, isolated across sessions', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());

    await dispatchToolAfter(hooks, 'solved-session-a', 'bash', { title: 't', output: 'ran the suite', metadata: {} });
    await dispatchToolAfter(hooks, 'solved-session-a', 'edit', { title: 't', output: 'src/a.ts updated', metadata: {} });
    await dispatchToolAfter(hooks, 'solved-session-b', 'bash', { title: 't', output: 'other session', metadata: {} });

    assert.deepEqual(sessionState.get('solved-session-a').solvedItems, [
      { tool: 'bash', outcome: 'ran the suite' },
      { tool: 'edit', outcome: 'src/a.ts updated' },
    ]);
    assert.deepEqual(sessionState.get('solved-session-b').solvedItems, [
      { tool: 'bash', outcome: 'other session' },
    ]);
  });
});

test('tool.execute.after retains solved items beyond the memo render cap (design D3)', async () => {
  await withCleanAuditEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_SOLVED_ITEMS = '2';
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'solved-session-bounded';

    for (const step of ['first', 'second', 'third']) {
      await dispatchToolAfter(hooks, sessionID, 'bash', { title: step, output: `${step} output`, metadata: {} });
    }

    // Design D3: storage retention (SOLVED_RETENTION_CAP, 50) is deeper
    // than the memo render cap, so recall can reach entries the memo no
    // longer shows — all three entries survive the env-capped render of 2.
    const state = sessionState.get(sessionID);
    assert.equal(state.solvedItems.length, 3);
    assert.deepEqual(
      state.solvedItems.map((item) => item.outcome),
      ['first output', 'second output', 'third output']
    );
    // FR-017 render bound: the memo still shows only the two most recent.
    const messages = await dispatchMemoTransform(hooks, sessionID);
    const memo = messageText(messages[1]);
    assert.ok(memo.includes('second output'));
    assert.ok(memo.includes('third output'));
    assert.ok(!memo.includes('first output'));
  });
});

test('critique delivery retains the critique log beyond the memo render cap (design D3)', async () => {
  await withCleanAuditEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_MAX_REGENERATIONS = '3';
    process.env.OPENCODE_SUPERVISOR_MEMO_MAX_CRITIQUES = '2';
    const { input, calls } = auditHarness([]);
    const hooks = await plugin.server(input);
    const sessionID = 'critique-log-bounded';

    // Three deterministic arithmetic failures (FR-003), all steered
    // under a maxRegenerations of 3 — three critiqueLog entries.
    await dispatchPart(hooks, completedReasoningPart({ sessionID, id: 'p1', text: 'a = 1 + 1 = 3' }));
    await dispatchPart(hooks, completedReasoningPart({ sessionID, id: 'p2', messageID: 'msg-2', text: 'b = 2 + 2 = 5' }));
    await dispatchPart(hooks, completedReasoningPart({ sessionID, id: 'p3', messageID: 'msg-3', text: 'c = 3 + 3 = 7' }));

    assert.equal(calls.promptAsync.length, 3);
    // Design D3: storage retention (CRITIQUE_RETENTION_CAP, 30) is deeper
    // than the memo render cap of 2 — all three critiques survive, and the
    // memo renders only the two most recent.
    const state = sessionState.get(sessionID);
    assert.equal(state.critiqueLog.length, 3);
    assert.deepEqual(
      state.critiqueLog.map((entry) => entry.delivered),
      [true, true, true]
    );
    const messages = await dispatchMemoTransform(hooks, sessionID);
    const memo = messageText(messages[1]);
    assert.ok(memo.includes('Recent critiques:'));
    assert.ok(!memo.includes(state.critiqueLog[0].text));
    assert.ok(memo.includes(state.critiqueLog[2].text));
  });
});

test('messages transform appends the supervision memo as a user message', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'memo-session-full';

    // Populate through the real hooks: the goal via chat.message
    // (FR-013) and solved items via tool.execute.after (FR-014)...
    await dispatchChatMessage(hooks, sessionID, {
      message: { id: 'm1', role: 'user' },
      parts: [{ type: 'text', text: 'Ship the memo injection' }],
    });
    await dispatchToolAfter(hooks, sessionID, 'bash', { title: 't', output: '3 tests passed', metadata: {} });
    await dispatchToolAfter(hooks, sessionID, 'edit', { title: 't', output: 'src/memo.ts updated', metadata: {} });
    // ...and one delivered critique (FR-015), seeded directly — the
    // task 3.3 tests cover how delivery records it.
    sessionState.get(sessionID).critiqueLog.push({
      text: 'Tighten the arithmetic bound.',
      severity: 'minor',
      delivered: true,
    });

    const messages = await dispatchMemoTransform(hooks, sessionID);

    // FR-016: the memo lands as one new trailing user message after
    // the conversation, carrying every populated section.
    assert.equal(messages.length, 2);
    assert.equal(messageText(messages[0]), 'user turn');
    const memoMessage = messages[1] as { info?: { role?: string; sessionID?: string } };
    assert.equal(memoMessage.info?.role, 'user');
    assert.equal(memoMessage.info?.sessionID, sessionID);
    const memo = messageText(messages[1]);
    assert.ok(memo.includes('[supervisor]'));
    assert.ok(memo.includes('Session goal:'));
    assert.ok(memo.includes('Ship the memo injection'));
    assert.ok(memo.includes('Recently solved:'));
    assert.ok(memo.includes('- bash: 3 tests passed'));
    assert.ok(memo.includes('- edit: src/memo.ts updated'));
    assert.ok(memo.includes('Recent critiques:'));
    assert.ok(memo.includes('[minor, delivered]'));
    assert.ok(memo.includes('Tighten the arithmetic bound.'));
  });
});

test('messages transform leaves the payload untouched when nothing is populated', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'memo-session-empty';

    // A known session with no goal, no solves, no critiques.
    sessionState.get(sessionID);
    const messages = await dispatchMemoTransform(hooks, sessionID);

    // buildMemo returned null: no memo message, same payload.
    assert.equal(messages.length, 1);
    assert.equal(messageText(messages[0]), 'user turn');
  });
});

test('messages transform degrades gracefully without a session or on odd payloads', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());

    // No sessionID derivable from the payload messages: nothing to
    // look up.
    const withoutSession = await dispatchMemoTransform(hooks, undefined);
    assert.equal(withoutSession.length, 1);

    // Unknown session: no state exists — and none is created.
    const unknownSession = await dispatchMemoTransform(hooks, 'memo-unknown-session');
    assert.equal(unknownSession.length, 1);
    assert.equal(sessionState.peek('memo-unknown-session'), undefined);

    // Odd payload — a populated session whose output carries no
    // messages array: the array guard holds, nothing throws.
    sessionState.get('memo-odd-session').goal = 'a goal';
    await assert.doesNotReject(() => dispatchMemoTransform(hooks, 'memo-odd-session', { omitMessages: true }));
  });
});

test('chat.message and tool.execute.after never reject on odd payloads', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());

    // Absent message/parts and non-array parts: no goal, no rejection.
    await assert.doesNotReject(() => dispatchChatMessage(hooks, 'odd-goal-session', {}));
    await assert.doesNotReject(() =>
      dispatchChatMessage(hooks, 'odd-goal-session', { message: { role: 'user' }, parts: 'not-an-array' })
    );
    assert.equal(sessionState.get('odd-goal-session').goal, undefined);

    // Absent or non-string tool output: the placeholder outcome, no
    // rejection (the typings expose no error field to read).
    await assert.doesNotReject(() => dispatchToolAfter(hooks, 'odd-solved-session', 'bash', {}));
    await assert.doesNotReject(() => dispatchToolAfter(hooks, 'odd-solved-session', 'bash', { output: 42 }));
    assert.deepEqual(sessionState.get('odd-solved-session').solvedItems, [
      { tool: 'bash', outcome: 'completed' },
      { tool: 'bash', outcome: 'completed' },
    ]);
  });
});

// ── Tool guard (task 3.5): FR-009..FR-012 through the live hook ──

/** Dispatches one tool.execute.before through the hook with raw args. */
function dispatchToolBefore(hooks: DispatchHooks, sessionID: string, tool: string, args: unknown): Promise<void> {
  return hooks['tool.execute.before']!({ tool, sessionID, callID: 'call-1' }, { args });
}

/**
 * FR-052 restated for tests: the plugin logs through the server's /log
 * endpoint (captured by `recordingPluginInput`), never console.* — the
 * log-routing tests below assert recorded entries instead of stderr.
 */

test('tool.execute.before proceeds for any file path when no verified trace exists', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'guard-empty-trace';

    // FR-011: no audited reasoning exists yet, so the file-path check
    // MUST NOT block — only reward-hacking patterns still apply.
    assert.equal(sessionState.get(sessionID).verifiedSteps.length, 0);
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'write', {
        filePath: 'src/never-audited.ts',
        content: 'export const x = 1;',
      })
    );
  });
});

test('tool.execute.before still blocks reward-hacking arguments with an empty trace', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'guard-empty-trace-hack';

    // FR-011's "only check active" clause, end to end: the trace is
    // empty, yet the reward-hacking pattern still blocks.
    assert.equal(sessionState.get(sessionID).verifiedSteps.length, 0);
    await assert.rejects(
      () => dispatchToolBefore(hooks, sessionID, 'bash', { command: 'git commit -m "bypass" --no-verify' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Execution blocked'));
        assert.ok(error.message.includes('reward-hacking'));
        assert.ok(error.message.includes('--no-verify'));
        return true;
      }
    );
  });
});

test('tool.execute.before blocks an unreferenced path with an actionable reason', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'guard-unreferenced';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    // FR-010 + FR-012: the rejection names the unmatched path and the
    // failed check, so the model can reason about the file and retry.
    await assert.rejects(
      () => dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'src/b.ts', content: 'export const y = 2;' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Execution blocked'));
        assert.ok(error.message.includes('src/b.ts'));
        assert.ok(error.message.includes('file-path trace check'));
        assert.ok(error.message.includes('absent from the verified reasoning trace'));
        return true;
      }
    );
  });
});

test('tool.execute.before proceeds for referenced paths by full path or basename', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());

    // FR-010: full-path match — trace and arguments both name src/a.ts.
    const fullTrace = 'guard-referenced-full';
    sessionState.get(fullTrace).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, fullTrace, 'edit', { filePath: 'src/a.ts', content: 'export const helper = 1;' })
    );
    // Basename match — the arguments carry the bare basename of a
    // path the trace holds in full.
    await assert.doesNotReject(() => dispatchToolBefore(hooks, fullTrace, 'bash', { command: 'cat a.ts' }));

    // Basename match the other way — a full path in the arguments
    // against a trace that only holds the basename.
    const baseTrace = 'guard-referenced-base';
    sessionState.get(baseTrace).verifiedSteps.push({ text: 'Refactor a.ts to export the helper.', passed: true });
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, baseTrace, 'edit', { filePath: 'src/a.ts', content: 'export const helper = 1;' })
    );
  });
});

test('tool.execute.before blocks every reward-hacking pattern with check and marker named', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'guard-hack-patterns';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    const patterns: Array<{ tool: string; args: Record<string, unknown>; marker: string }> = [
      { tool: 'bash', args: { command: 'git commit -m "bypass" --no-verify' }, marker: '--no-verify' },
      {
        tool: 'write',
        args: { filePath: 'src/a.ts', content: "it.skip('flaky test', () => {});" },
        marker: '.skip(',
      },
      {
        tool: 'write',
        args: { filePath: 'src/a.ts', content: 'expect(true).toBe(true);' },
        marker: 'expect(true).toBe(true)',
      },
      { tool: 'bash', args: { command: 'rm -rf tests' }, marker: 'rm -rf tests' },
    ];
    for (const { tool, args, marker } of patterns) {
      // FR-009 + FR-012: every pattern blocks through the hook with a
      // reason naming the reward-hacking check and the matched marker.
      await assert.rejects(
        () => dispatchToolBefore(hooks, sessionID, tool, args),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('Execution blocked'));
          assert.ok(error.message.includes('reward-hacking'));
          assert.ok(error.message.includes(marker));
          return true;
        }
      );
    }
  });
});

test('tool guard consumes the live verified trace populated by the event hook', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness(['{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}']);
    const hooks = await plugin.server(input);
    const sessionID = 'guard-live-trace';

    // FR-006 wiring: a completed reasoning part flows through the real
    // event hook; the mocked passing audit lands its stripped text in
    // the session's verified trace.
    await dispatchPart(
      hooks,
      completedReasoningPart({
        sessionID,
        id: 'part-guard',
        text: 'the edit targets `src/a.ts` to export the helper',
      })
    );
    assert.equal(calls.create.length, 1); // the audit really ran
    assert.deepEqual(sessionState.get(sessionID).verifiedSteps, [
      { text: 'the edit targets `src/a.ts` to export the helper', passed: true },
    ]);

    // A tool call referencing the traced path proceeds (FR-010)...
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'edit', { filePath: 'src/a.ts', content: 'export const helper = 1;' })
    );
    // ...and one referencing an unrelated path blocks, naming it (FR-012).
    await assert.rejects(
      () =>
        dispatchToolBefore(hooks, sessionID, 'write', {
          filePath: 'src/unrelated.ts',
          content: 'export const z = 9;',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Execution blocked'));
        assert.ok(error.message.includes('src/unrelated.ts'));
        assert.ok(error.message.includes('file-path trace check'));
        return true;
      }
    );
  });
});

test('tool.execute.before fails open when the guard infrastructure throws', async () => {
  await withCleanAuditEnv(async () => {
    const { input, logEntries } = recordingPluginInput();
    const hooks = await plugin.server(input);
    const sessionID = 'guard-corrupted-state';
    const state = sessionState.get(sessionID);
    // Corrupted state entry: a non-array verifiedSteps makes
    // verifyToolIntent throw — the hook must resolve and the call must
    // proceed; a guard crash must never block or break the session.
    (state as { verifiedSteps: { text: string; passed: boolean }[] | null }).verifiedSteps = null;

    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'bash', { command: 'cat src/anything.ts' })
    );
    // FR-052: the fail-open trace rides the server log, not stderr.
    assert.ok(logEntries.some((entry) => entry.level === 'error' && entry.message.includes('tool guard failed open')));

    // Drop the corrupted entry so nothing later observes it.
    sessionState.cleanup(sessionID);
  });
});

test('tool.execute.before logs every block with the reason before throwing', async () => {
  await withCleanAuditEnv(async () => {
    const { input, logEntries } = recordingPluginInput();
    const hooks = await plugin.server(input);
    const sessionID = 'guard-block-log';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    // Spike 1.3, restated for FR-052: the host does not log trigger
    // failures, so the plugin's own server-log entry is the block's
    // only trace.
    await assert.rejects(
      () => dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'src/b.ts', content: 'export const y = 2;' }),
      /Execution blocked/
    );
    assert.ok(
      logEntries.some(
        (entry) =>
          entry.level === 'error' &&
          entry.message.includes('blocked tool') &&
          entry.message.includes('src/b.ts') &&
          entry.message.includes('file-path trace check')
      )
    );
  });
});

test('tool.execute.before honors disabled guard checks via configuration', async () => {
  // Reward-hacking check disabled through the env tier — the hook
  // input carries no session object, so the session-config tier
  // cannot reach this hook (its precedence is covered by the
  // resolveHookConfig test above).
  await withCleanAuditEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING = 'false';
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'guard-config-reward-off';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'bash', { command: 'git commit -m "bypass" --no-verify' })
    );
  });

  // File-path trace check disabled: an unreferenced path proceeds.
  await withCleanAuditEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS = 'false';
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'guard-config-trace-off';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'write', {
        filePath: 'src/never-referenced.ts',
        content: 'export const z = 3;',
      })
    );
  });
});

test('tool.execute.before satisfies a wildcard from a trace reference end to end (FR-066)', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());

    // The #36 field scenario, end to end: the trace names a concrete
    // file the batch pattern expands to, so the routed batch proceeds.
    const sessionID = 'guard-pattern-satisfied';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'index the batch at kb/topics/gov-ci.md', passed: true });
    await assert.doesNotReject(() => dispatchToolBefore(hooks, sessionID, 'bash', { command: 'cat kb/topics/*.md' }));

    // Without a satisfying reference the same call blocks, and the
    // reason names the pattern with its corrective action.
    const bare = 'guard-pattern-blocked';
    sessionState.get(bare).verifiedSteps.push({ text: 'edit src/a.ts to export the helper', passed: true });
    await assert.rejects(
      () => dispatchToolBefore(hooks, bare, 'bash', { command: 'cat kb/topics/*.md' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.includes('file-path trace check'), message);
        assert.ok(message.includes('kb/topics/*.md'), message);
        assert.ok(message.includes('pattern'), message);
        return true;
      }
    );
  });
});

test('tool.execute.before leaves the request_audit channel open end to end (FR-065)', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'guard-console-exempt';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'edit src/a.ts to export the helper', passed: true });

    // The focus names an unreferenced path; the call still proceeds —
    // the exemption is derived from the registered tool map, so the
    // audit channel that exists to keep the loop open stays open.
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'request_audit', { focus: 'audit the change at ops/risk-tier1.sh' })
    );

    // The reward-hacking check still applies to the console channel.
    await assert.rejects(
      () => dispatchToolBefore(hooks, sessionID, 'request_audit', { focus: 'bypass with git commit --no-verify now' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.includes('reward-hacking'), message);
        return true;
      }
    );
  });
});

test('dispose clears all session state', async () => {
  const hooks = await plugin.server(silentPluginInput());

  await hooks.event!({
    event: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-9',
          sessionID: 'dispose-session-1',
          messageID: 'msg-9',
          type: 'reasoning',
          text: 'x = 1 + 1 = 2',
          time: { start: 1, end: 2 },
        },
      },
    },
  } as unknown as EventHookInput);
  assert.equal(sessionState.get('dispose-session-1').seenParts.size, 1);

  await hooks.dispose!();
  assert.equal(sessionState.get('dispose-session-1').seenParts.size, 0);
});

// ── Self-suppression (review iteration 2): the plugin's own side ──

test("hooks ignore the plugin's own auditor side sessions (self-suppression)", async () => {
  await withCleanAuditEnv(async () => {
    // A client whose session.prompt parks until the test releases it,
    // so the side session is LIVE — registered for self-suppression —
    // while the side-session traffic below is dispatched: exactly the
    // window in which the runtime would re-enter the hooks (review
    // iteration 2, HIGH — the host dispatches every bus event in the
    // plugin's directory, and side sessions share that directory).
    const calls = {
      create: [] as unknown[],
      promptAsync: [] as unknown[],
      abort: [] as unknown[],
      delete: [] as unknown[],
    };
    const parkedResolvers: Array<(response: unknown) => void> = [];
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
      directory: '/tmp/supervisor-hook-test',
    };
    const hooks = await plugin.server(input as unknown as PluginInput);

    // One audit through the live event hook; the parked prompt keeps
    // side session 'auditor-side-live' in flight.
    const supervisedID = 'supervised-self-suppression';
    const auditRun = dispatchPart(hooks, completedReasoningPart({ sessionID: supervisedID }));
    // One macrotask boundary: every microtask ahead of the parked
    // prompt (create, self-suppression registration, prompt dispatch)
    // has settled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.create.length, 1); // the side session exists...
    assert.equal(parkedResolvers.length, 1); // ...parked in its prompt

    // Side-session traffic while it is live — each dispatch would
    // mutate plugin state or spawn work if the hooks did not
    // short-circuit: a completed reasoning part (recursive audit), a
    // user message (goal capture), a tool call (guard trace state and
    // solved items), and a messages transform (memo injection).
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID: 'auditor-side-live', id: 'part-side', messageID: 'msg-side' })
    );
    await dispatchChatMessage(hooks, 'auditor-side-live', {
      message: { id: 'm1', role: 'user' },
      parts: [{ type: 'text', text: 'audit prompt text' }],
    });
    await dispatchToolBefore(hooks, 'auditor-side-live', 'read', { filePath: 'src/anything.ts' });
    await dispatchToolAfter(hooks, 'auditor-side-live', 'bash', { title: 't', output: 'side output', metadata: {} });
    const sideMessages = await dispatchMemoTransform(hooks, 'auditor-side-live');

    // All of it ignored: no recursive audit (create stays at one), no
    // critique traffic, no state entry for the side session, and no
    // memo message — the supervised conversation, not the plugin's
    // own machinery, is what these hooks observe.
    assert.equal(calls.create.length, 1);
    assert.equal(calls.promptAsync.length, 0);
    assert.equal(calls.abort.length, 0);
    assert.equal(sessionState.peek('auditor-side-live'), undefined);
    assert.equal(sideMessages.length, 1);

    // Release the parked audit: it completes normally for the
    // supervised session — the passed step lands in its trace, and
    // the side session is deleted exactly once.
    parkedResolvers[0]({
      data: {
        info: {},
        parts: [{ type: 'text', text: '{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}' }],
      },
    });
    await auditRun;
    assert.equal(calls.create.length, 1);
    assert.equal(calls.delete.length, 1);
    assert.deepEqual(sessionState.peek(supervisedID)?.verifiedSteps, [{ text: 'the rate = 24 * 15 = 360', passed: true }]);
  });
});

// ── Audit coordination (task 5.4): FR-067 bounded wait, FR-068 loop ──

/**
 * FR-067 race harness: a plugin input whose side-session prompt parks
 * until the test releases it — the in-flight audit the bounded trace
 * wait consumes — while app.log records entries for the timeout and
 * rejection assertions. Fresh mock client per test — no network.
 */
function raceHarness(): {
  input: PluginInput;
  logEntries: Array<{ level: string; message: string }>;
  parkedResolvers: Array<(text: string) => void>;
} {
  const logEntries: Array<{ level: string; message: string }> = [];
  const parkedResolvers: Array<(text: string) => void> = [];
  const input = {
    client: {
      session: {
        create: async () => ({ data: { id: 'auditor-side-race' } }),
        // Parking prompt: the audit continuation suspends here until
        // the test hands back a verdict, so `pendingAudits` stays
        // non-empty for as long as the test chooses.
        prompt: () =>
          new Promise<{ data: { info: unknown; parts: Array<{ type: 'text'; text: string }> } }>((resolve) => {
            parkedResolvers.push((text: string) => resolve({ data: { info: {}, parts: [{ type: 'text', text }] } }));
          }),
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
    directory: '/tmp/supervisor-race-test',
  };
  return { input: input as unknown as PluginInput, logEntries, parkedResolvers };
}

/** The queued passing verdict every battery cleanup path releases the parked audit with. */
const PASSED_VERDICT = '{"passed":true,"failedStep":null,"severity":null,"critique":"Verified."}';

test('tool.execute.before waits for an in-flight audit and allows once the step lands (FR-067)', async () => {
  await withCleanAuditEnv(async () => {
    const harness = raceHarness();
    const hooks = await plugin.server(harness.input);
    const sessionID = 'race-settled';

    // GIVEN: the trace already holds an earlier verified step.
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    // ...and a reasoning part naming notes.md is still being audited:
    // the dispatch is fire-and-forget, parked on the harness prompt.
    const dispatch = dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'part-race', text: 'I will record the outcome in notes.md.' })
    );
    // The continuation registers synchronously with the dispatch.
    assert.equal(sessionState.get(sessionID).pendingAudits.size, 1);

    // WHEN: a tool call on the path arrives before the audit completes.
    const call = dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'session summary' });
    // One macrotask boundary: the call has entered its bounded wait
    // (the only await ahead of it — config resolution — is resolved).
    await new Promise((resolve) => setTimeout(resolve, 5));

    // THEN: the audit resolves within the bound and the single attempt
    // passes — no first-attempt block, no timeout charged.
    harness.parkedResolvers[0](PASSED_VERDICT);
    await assert.doesNotReject(() => call);
    await dispatch;

    const state = sessionState.get(sessionID);
    assert.deepEqual(state.verifiedSteps, [
      { text: 'Edit src/a.ts to export the helper.', passed: true },
      { text: 'record the outcome in notes.md.', passed: true },
    ]);
    assert.equal(state.pendingAudits.size, 0); // deregistered in the finally
    assert.equal(state.timeoutFailOpens, 0);
    assert.ok(!harness.logEntries.some((entry) => entry.message.includes('trace-check wait timed out')));
  });
});

test('a rejected in-flight audit settles the trace-check wait without throwing into the hook (FR-067)', async () => {
  await withCleanAuditEnv(async () => {
    const harness = raceHarness();
    const hooks = await plugin.server(harness.input);
    const sessionID = 'race-rejected';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    // Every public continuation layer is fail-open by FR-005 (the peer
    // audit, critique delivery, and the derived-model lookup all
    // catch), so no public vector produces a rejected continuation
    // without also degrading this hook's own config resolution. The
    // rejection is injected at the state seam the wait consumes — the
    // same `pendingAudits` registration the event hook owns. A no-op
    // catch marks the promise handled up front (the wait's allSettled
    // does the real observation), so no unhandled-rejection window.
    const poisoned = Promise.reject(new Error('audit continuation crashed'));
    poisoned.catch(() => {});
    sessionState.get(sessionID).pendingAudits.set(poisoned, []);

    // The call blocks with the trace reason — the live trace is
    // unchanged by the rejection — and the rejection never escapes
    // into the hook: the wait settles, logs it once, and the guard
    // re-checks the trace.
    await assert.rejects(
      () => dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'src/b.ts', content: 'export const y = 2;' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('file-path trace check'));
        assert.ok(error.message.includes('src/b.ts'));
        return true;
      }
    );
    const rejections = harness.logEntries.filter((entry) => entry.message.includes('in-flight audit continuation rejected'));
    assert.equal(rejections.length, 1);
    assert.ok(rejections[0].message.includes('audit continuation crashed'));
    assert.equal(sessionState.get(sessionID).timeoutFailOpens, 0);
  });
});

test('a covered trace-check wait that times out fails open on its own budget (FR-067, FR-070)', async () => {
  await withCleanAuditEnv(async () => {
    const harness = raceHarness();
    const hooks = await plugin.server(harness.input);
    const sessionID = 'race-timeout';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    // The bound is shrunk from the 10 s default so the timeout fires
    // in milliseconds; the default is restored in the finally.
    const savedTimeoutMs = traceAwaitState.timeoutMs;
    traceAwaitState.timeoutMs = 15;
    let dispatch: Promise<void> | undefined;
    try {
      dispatch = dispatchPart(
        hooks,
        completedReasoningPart({ sessionID, id: 'part-timeout', text: 'I will record the outcome in notes.md.' })
      );
      // The correction is provably in flight — the parked audit's
      // step names notes.md — so the timeout is covered (FR-070):
      // the call is allowed on the covered budget, and the uncovered
      // budget is not charged.
      await assert.doesNotReject(() =>
        dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'session summary' })
      );
      const warnings = harness.logEntries.filter(
        (entry) => entry.level === 'warn' && entry.message.includes('trace-check wait timed out')
      );
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].message.includes('covered token'));
      assert.ok(warnings[0].message.includes('failing open (1/6)'));
      assert.equal(sessionState.get(sessionID).coveredTimeoutFailOpens, 1);
      assert.equal(sessionState.get(sessionID).timeoutFailOpens, 0);
    } finally {
      // Release the parked audit and settle the fire-and-forget hook so
      // nothing leaks past the test.
      harness.parkedResolvers[0]?.(PASSED_VERDICT);
      await dispatch;
      traceAwaitState.timeoutMs = savedTimeoutMs;
    }
  });
});

test('repeated uncovered trace-check timeouts block at the per-session fail-open cap (FR-067)', async () => {
  await withCleanAuditEnv(async () => {
    // Cap 1 through the env tier: the first timeout fails open
    // (below the cap), the second blocks (past it).
    process.env.OPENCODE_SUPERVISOR_MAX_TIMEOUT_FAIL_OPENS = '1';
    const harness = raceHarness();
    const hooks = await plugin.server(harness.input);
    const sessionID = 'race-cap';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    const savedTimeoutMs = traceAwaitState.timeoutMs;
    traceAwaitState.timeoutMs = 15;
    let dispatch: Promise<void> | undefined;
    try {
      // The parked audit's step names other.md, not notes.md — the
      // waits below are uncovered, so they charge the original
      // budget (FR-070's uncovered path).
      dispatch = dispatchPart(
        hooks,
        completedReasoningPart({ sessionID, id: 'part-cap', text: 'I will record the outcome in other.md.' })
      );
      // First timeout — below the cap: allowed, one warning logged.
      await assert.doesNotReject(() =>
        dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'session summary' })
      );
      assert.ok(
        harness.logEntries.some(
          (entry) => entry.level === 'warn' && entry.message.includes('trace-check wait timed out') && entry.message.includes('failing open (1/1)')
        )
      );
      assert.ok(!harness.logEntries.some((entry) => entry.message.includes('covered token')));
      // Second timeout — past the cap: the call blocks, the reason
      // names the still-unsettled audit and the corrective action.
      await assert.rejects(
        () => dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'retry summary' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('still unsettled'));
          assert.ok(error.message.includes('timeout fail-open cap (1)'));
          assert.ok(error.message.includes('Wait for the audit to settle'));
          return true;
        }
      );
      // Every timeout is logged: the blocked one rides the block's
      // error entry, which names the unsettled audit.
      assert.ok(
        harness.logEntries.some(
          (entry) =>
            entry.level === 'error' && entry.message.includes('blocked tool') && entry.message.includes('still unsettled')
        )
      );
      assert.equal(sessionState.get(sessionID).timeoutFailOpens, 2);
      assert.equal(sessionState.get(sessionID).coveredTimeoutFailOpens, 0);
    } finally {
      harness.parkedResolvers[0]?.(PASSED_VERDICT);
      await dispatch;
      traceAwaitState.timeoutMs = savedTimeoutMs;
    }
  });
});

test('repeated covered timeouts block at the covered fail-open cap (FR-070)', async () => {
  await withCleanAuditEnv(async () => {
    // Covered cap 1 through the env tier: the first covered timeout
    // fails open, the second blocks past it.
    process.env.OPENCODE_SUPERVISOR_MAX_COVERED_TIMEOUT_FAIL_OPENS = '1';
    const harness = raceHarness();
    const hooks = await plugin.server(harness.input);
    const sessionID = 'race-covered-cap';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    const savedTimeoutMs = traceAwaitState.timeoutMs;
    traceAwaitState.timeoutMs = 15;
    let dispatch: Promise<void> | undefined;
    try {
      dispatch = dispatchPart(
        hooks,
        completedReasoningPart({ sessionID, id: 'part-covered-cap', text: 'I will record the outcome in notes.md.' })
      );
      // First covered timeout — below the covered cap: allowed, the
      // warning names the covered budget.
      await assert.doesNotReject(() =>
        dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'session summary' })
      );
      assert.ok(
        harness.logEntries.some(
          (entry) => entry.level === 'warn' && entry.message.includes('covered token') && entry.message.includes('failing open (1/1)')
        )
      );
      // Second covered timeout — past the covered cap: the call
      // blocks naming the still-unsettled audit.
      await assert.rejects(
        () => dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'retry summary' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('still unsettled'));
          assert.ok(error.message.includes('covered timeout fail-open cap (1)'));
          assert.ok(error.message.includes('Wait for the audit to settle'));
          return true;
        }
      );
      assert.equal(sessionState.get(sessionID).coveredTimeoutFailOpens, 2);
      assert.equal(sessionState.get(sessionID).timeoutFailOpens, 0);
    } finally {
      harness.parkedResolvers[0]?.(PASSED_VERDICT);
      await dispatch;
      traceAwaitState.timeoutMs = savedTimeoutMs;
    }
  });
});

test('a settled wait whose correction was audited but evicted says so (FR-070)', async () => {
  await withCleanAuditEnv(async () => {
    const harness = raceHarness();
    const hooks = await plugin.server(harness.input);
    const sessionID = 'race-evicted';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    const PEER_FAILED_VERDICT = '{"passed":false,"failedStep":0,"severity":"minor","critique":"The claim is not verifiable."}';
    const dispatch = dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'part-evicted', text: 'I will record the outcome in notes.md.' })
    );
    const call = dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'session summary' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The audit fails as a peer verdict — the step is evicted, so the
    // settled wait still blocks, and the reason names the eviction
    // instead of blaming absent reasoning (FR-070, design D5).
    harness.parkedResolvers[0](PEER_FAILED_VERDICT);
    await assert.rejects(
      () => call,
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('recent reasoning named'));
        assert.ok(error.message.includes('notes.md'));
        assert.ok(error.message.includes('audit did not pass'));
        return true;
      }
    );
    await dispatch;
    assert.equal(sessionState.get(sessionID).timeoutFailOpens, 0);
    assert.equal(sessionState.get(sessionID).coveredTimeoutFailOpens, 0);
  });
});

test('a settled trace with no in-flight audits still blocks absent paths (FR-067 teeth)', async () => {
  await withCleanAuditEnv(async () => {
    const hooks = await plugin.server(silentPluginInput());
    const sessionID = 'race-teeth';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });
    assert.equal(sessionState.get(sessionID).pendingAudits.size, 0);

    // The wait exists only for trace races: with nothing in flight the
    // block is immediate and no fail-open budget is spent.
    await assert.rejects(
      () => dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'src/b.ts', content: 'export const y = 2;' }),
      /file-path trace check/
    );
    assert.equal(sessionState.get(sessionID).timeoutFailOpens, 0);
  });
});

test('the empty-trace allow imposes no wait even with an audit in flight (FR-011, FR-067)', async () => {
  await withCleanAuditEnv(async () => {
    const harness = raceHarness();
    const hooks = await plugin.server(harness.input);
    const sessionID = 'race-empty-trace';

    // No verified steps at all — only the in-flight audit exists.
    const dispatch = dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'part-empty', text: 'I will record the outcome in notes.md.' })
    );
    assert.equal(sessionState.get(sessionID).pendingAudits.size, 1);

    // FR-011: the call proceeds immediately — while the audit is still
    // parked on the harness prompt, which only this test can release —
    // and no wait or fail-open budget is charged.
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'src/never-audited.ts', content: 'export const z = 3;' })
    );
    assert.equal(sessionState.get(sessionID).timeoutFailOpens, 0);
    assert.ok(!harness.logEntries.some((entry) => entry.message.includes('trace-check wait')));

    harness.parkedResolvers[0](PASSED_VERDICT);
    await dispatch;
  });
});

test('the corrective instruction loop closes end to end: block, prose re-statement, retry (FR-068)', async () => {
  await withCleanAuditEnv(async () => {
    const { input, calls } = auditHarness([PASSED_VERDICT]);
    const hooks = await plugin.server(input);
    const sessionID = 'corrective-e2e';
    sessionState.get(sessionID).verifiedSteps.push({ text: 'Edit src/a.ts to export the helper.', passed: true });

    // First attempt: the block reason instructs the model to reason
    // about the file in verified steps, then retry (FR-012).
    await assert.rejects(
      () => dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'session summary' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('notes.md'));
        assert.ok(error.message.includes('Name the file in verified steps'));
        return true;
      }
    );

    // The model re-states its plan in plain prose naming the file — no
    // code ticks, no operators — and the audit passes it: FR-068's
    // survival is what lets the re-statement reach the audit at all.
    await dispatchPart(
      hooks,
      completedReasoningPart({ sessionID, id: 'part-corrective', text: 'I will update notes.md with the session summary.' })
    );
    assert.equal(calls.create.length, 1); // the re-statement really was audited
    assert.deepEqual(sessionState.get(sessionID).verifiedSteps, [
      { text: 'Edit src/a.ts to export the helper.', passed: true },
      { text: 'update notes.md with the session summary.', passed: true },
    ]);

    // The retried call passes: the prose mention reached the trace.
    await assert.doesNotReject(() =>
      dispatchToolBefore(hooks, sessionID, 'write', { filePath: 'notes.md', content: 'session summary' })
    );
  });
});
