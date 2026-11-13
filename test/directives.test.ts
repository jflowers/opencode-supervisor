import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks } from '@opencode-ai/plugin';
import plugin, { logIdentityState, sessionState } from '../index.ts';
import { completedReasoningPart, recordingPluginInput, silentPluginInput, withCleanSupervisorEnv } from './mocks.ts';
import {
  activeDirectives,
  compileEnforcement,
  compileTriggers,
  describeDirectiveSources,
  evaluateEnforcement,
  extractDirectivePaths,
  extractPolicyPaths,
  globToRegExp,
  matchesPaths,
  matchTriggers,
  MAX_DIRECTIVE_FILES,
  MAX_DIRECTIVES,
  MAX_NESTED_ARG_DEPTH,
  MAX_NESTED_ARG_STRINGS,
  MAX_DIRECTIVE_TEXT,
  MAX_DIRECTIVES_RENDER_BUDGET,
  parseDirectives,
  parseOptionsDirectives,
  renderDirectives,
  renderDirectivesAdvisory,
  type Directive,
} from '../src/directives.ts';
import { buildMemo, DEFAULT_MEMO_LIMITS } from '../src/memo.ts';
import { runPeerAudit, type AuditConfig, type InvokeModel } from '../src/auditor.ts';

// ── Helpers (each test file is self-contained) ──

/** Builds one directive markdown file: advisory text plus an optional rules fence. */
function directiveFile(text: string, rules: object | null): string {
  if (!rules) return text;
  return `${text}\n\n\`\`\`supervisor\n${JSON.stringify(rules)}\n\`\`\`\n`;
}

/** Creates a temp project dir with the given directive files; returns its path. */
function makeDirectiveDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-directives-'));
  const directivesDir = path.join(dir, '.opencode', 'supervisor', 'directives');
  fs.mkdirSync(directivesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directivesDir, name), content);
  }
  return dir;
}

// recordingPluginInput and silentPluginInput now live in ./mocks.ts
// (review rounds 2 and 4).

/** Event-hook input shape, for casting deliberately undeclared event payloads. */
type EventHookInput = Parameters<NonNullable<Hooks['event']>>[0];

/** Dispatches one message.part.updated event through the hook. */
function dispatchPart(hooks: Hooks, part: unknown): Promise<void> {
  return hooks.event!({ event: { type: 'message.part.updated', properties: { part } } } as unknown as EventHookInput);
}

/** Dispatches one tool.execute.before through the hook with raw args. */
function dispatchToolBefore(hooks: Hooks, sessionID: string, tool: string, args: unknown): Promise<void> {
  return hooks['tool.execute.before']!({ tool, sessionID, callID: 'call-1' }, { args });
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

/** A fixed no-secrets directive used across guard and memo tests. */
const NO_SECRETS_TEXT = 'Never read, print, or copy secret material.';

const NO_SECRETS_RULES = { enforce: [{ forbidPath: 'secrets/**' }] };

// ── Pure module: parseDirectives (FR-026, FR-027) ──

test('parseDirectives reads a file with advisory text and a rules fence', () => {
  const { directives, warnings } = parseDirectives([
    { name: 'no-secrets.md', content: directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES) },
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(directives.length, 1);
  assert.equal(directives[0].id, 'no-secrets');
  assert.equal(directives[0].text, NO_SECRETS_TEXT);
  assert.deepEqual(directives[0].enforce, [{ forbidPath: 'secrets/**' }]);
  assert.equal(directives[0].when, undefined);
});

test('parseDirectives accepts a text-only advisory file without a fence', () => {
  const { directives, warnings } = parseDirectives([
    { name: 'prefer-bun.md', content: 'Run tests with bun, not node.' },
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(directives, [{ id: 'prefer-bun', text: 'Run tests with bun, not node.' }]);
});

test('parseDirectives skips a file whose rules fence is not valid JSON', () => {
  const broken = `${NO_SECRETS_TEXT}\n\n\`\`\`supervisor\n{"enforce": [}\n\`\`\`\n`;
  const { directives, warnings } = parseDirectives([{ name: 'broken.md', content: broken }]);
  assert.deepEqual(directives, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('broken.md'));
});

test('parseDirectives skips a file with neither text nor rules', () => {
  const { directives, warnings } = parseDirectives([{ name: 'empty.md', content: '   \n\t ' }]);
  assert.deepEqual(directives, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('empty.md'));
});

test('parseDirectives drops invalid rule entries and rules beyond the per-directive cap', () => {
  const rules = {
    enforce: [
      { forbidPath: 'secrets/**' },
      { forbidPattern: 'git\\s+push\\s+--force' },
      { unrelated: true },
      'not-an-object',
      { forbidPath: 'a/**' },
      { forbidPath: 'b/**' },
      { forbidPath: 'c/**' },
      { forbidPath: 'd/**' },
      { forbidPath: 'e/**' },
      { forbidPath: 'f/**' },
      { forbidPath: 'g/**' },
      { forbidPath: 'h/**' },
    ],
  };
  const { directives, warnings } = parseDirectives([
    { name: 'capped.md', content: directiveFile('policy', rules) },
  ]);
  assert.equal(directives.length, 1);
  // 12 entries, 2 invalid, 10 kept: the cap keeps the first ten raw entries
  // minus the invalid ones, so 8 survive.
  assert.equal(directives[0].enforce?.length, 8);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("'capped'"));
  assert.ok(warnings[0].includes('4 enforce rule(s) skipped'));
});

test('parseDirectives truncates advisory text at the fixed ceiling', () => {
  const long = 'x'.repeat(MAX_DIRECTIVE_TEXT + 500);
  const { directives } = parseDirectives([{ name: 'long.md', content: long }]);
  assert.equal(directives[0].text.length, MAX_DIRECTIVE_TEXT);
});

test('parseDirectives parses when-rules alongside enforce-rules', () => {
  const rules = {
    enforce: [{ forbidPath: 'secrets/**' }],
    when: [{ tool: 'bash' }, { path: 'src/crypto/**' }],
  };
  const { directives } = parseDirectives([
    { name: 'mixed.md', content: directiveFile('policy', rules) },
  ]);
  assert.deepEqual(directives[0].when, [{ tool: 'bash' }, { path: 'src/crypto/**' }]);
});

// ── Pure module: approve and review rule kinds (FR-043, FR-047, FR-048) ──

test('parseDirectives reads approve and review rules from the fence', () => {
  const rules = {
    approve: [{ id: 'deploy', tool: 'bash' }],
    review: [{ path: 'src/billing/**' }],
  };
  const { directives, warnings } = parseDirectives([
    { name: 'gated.md', content: directiveFile('Gate production changes.', rules) },
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(directives.length, 1);
  assert.equal(directives[0].id, 'gated');
  assert.equal(directives[0].text, 'Gate production changes.');
  assert.deepEqual(directives[0].approve, [{ id: 'deploy', tool: 'bash' }]);
  assert.deepEqual(directives[0].review, [{ path: 'src/billing/**' }]);
});

test('parseOptionsDirectives accepts approve and review rules from the tuple channel', () => {
  const { directives, warnings } = parseOptionsDirectives([
    { id: 'opt-gates', text: 'Gate deploys.', approve: [{ tool: 'bash' }], review: [{ path: 'ops/**' }] },
  ]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(directives[0].approve, [{ tool: 'bash' }]);
  assert.deepEqual(directives[0].review, [{ path: 'ops/**' }]);
});

test('parseDirectives drops invalid approve rules with a warning while keeping valid ones', () => {
  const rules = { approve: [{ tool: 42 }, { tool: 'bash' }] };
  const { directives, warnings } = parseDirectives([
    { name: 'mixed-gates.md', content: directiveFile('Policy.', rules) },
  ]);
  assert.deepEqual(directives[0].approve, [{ tool: 'bash' }]);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("'mixed-gates'"));
  assert.ok(warnings[0].includes('1 approve rule(s) skipped'));
});

test('parseDirectives drops review rules without a path with a warning', () => {
  const rules = { review: [{}, { path: 'ops/**' }] };
  const { directives, warnings } = parseDirectives([
    { name: 'review-gates.md', content: directiveFile('Policy.', rules) },
  ]);
  assert.deepEqual(directives[0].review, [{ path: 'ops/**' }]);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('1 review rule(s) skipped'));
});

test('parseDirectives bounds approve and review rules per kind at the shared cap', () => {
  const rules = {
    approve: Array.from({ length: 12 }, (_, i) => ({ tool: `t${i}` })),
    review: Array.from({ length: 12 }, (_, i) => ({ path: `p${i}/**` })),
  };
  const { directives, warnings } = parseDirectives([
    { name: 'capped-gates.md', content: directiveFile('Policy.', rules) },
  ]);
  assert.equal(directives[0].approve?.length, 10);
  assert.equal(directives[0].review?.length, 10);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes('2 approve rule(s) skipped')));
  assert.ok(warnings.some((w) => w.includes('2 review rule(s) skipped')));
});

test('advisory rendering carries directive text only, never gate rule internals', () => {
  const { directives } = parseDirectives([
    {
      name: 'gated.md',
      content: directiveFile('Gate production changes.', {
        approve: [{ id: 'deploy', tool: 'bash' }],
        review: [{ path: 'src/billing/**' }],
      }),
    },
  ]);
  const rendered = renderDirectivesAdvisory(directives, MAX_DIRECTIVES_RENDER_BUDGET) ?? '';
  assert.ok(rendered.includes('gated'));
  assert.ok(rendered.includes('Gate production changes.'));
  assert.ok(!rendered.includes('deploy'));
  assert.ok(!rendered.includes('src/billing'));
});

test('parseDirectives skips a file whose rules fence is JSON null', () => {
  const nulled = `${NO_SECRETS_TEXT}\n\n\`\`\`supervisor\nnull\n\`\`\`\n`;
  const { directives, warnings } = parseDirectives([{ name: 'nulled.md', content: nulled }]);
  assert.deepEqual(directives, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('nulled.md'));
  assert.ok(warnings[0].includes('not a JSON object'));
});

test('parseDirectives skips a file whose rules fence is a JSON array', () => {
  const arrayed = `${NO_SECRETS_TEXT}\n\n\`\`\`supervisor\n[]\n\`\`\`\n`;
  const { directives, warnings } = parseDirectives([{ name: 'arrayed.md', content: arrayed }]);
  assert.deepEqual(directives, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('arrayed.md'));
  assert.ok(warnings[0].includes('not a JSON object'));
});

test('parseDirectives reads rules from a fence in a CRLF file', () => {
  const crlf = `${NO_SECRETS_TEXT}\r\n\r\n\`\`\`supervisor\r\n${JSON.stringify(NO_SECRETS_RULES)}\r\n\`\`\`\r\n`;
  const { directives, warnings } = parseDirectives([{ name: 'crlf.md', content: crlf }]);
  assert.deepEqual(warnings, []);
  assert.equal(directives.length, 1);
  assert.equal(directives[0].id, 'crlf');
  assert.equal(directives[0].text, NO_SECRETS_TEXT);
  assert.deepEqual(directives[0].enforce, [{ forbidPath: 'secrets/**' }]);
});

test('parseDirectives warns when advisory text is truncated', () => {
  const long = 'y'.repeat(MAX_DIRECTIVE_TEXT + 10);
  const { directives, warnings } = parseDirectives([{ name: 'long.md', content: long }]);
  assert.equal(directives[0].text.length, MAX_DIRECTIVE_TEXT);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("'long'"));
  assert.ok(warnings[0].includes(`truncated from ${MAX_DIRECTIVE_TEXT + 10} to ${MAX_DIRECTIVE_TEXT} characters`));
});

// ── Pure module: parseOptionsDirectives (FR-026) ──

test('parseOptionsDirectives validates entries and defaults missing ids', () => {
  const { directives, warnings } = parseOptionsDirectives([
    { text: 'first', enforce: [{ forbidPattern: 'rm\\s+-rf\\s+/' }] },
    { id: 'custom', text: 'second' },
    { text: '' },
  ]);
  assert.equal(directives.length, 2);
  assert.equal(directives[0].id, 'd1');
  assert.deepEqual(directives[0].enforce, [{ forbidPattern: 'rm\\s+-rf\\s+/' }]);
  assert.equal(directives[1].id, 'custom');
  assert.equal(warnings.length, 1);
});

test('parseOptionsDirectives ignores a non-array value with a warning', () => {
  const { directives, warnings } = parseOptionsDirectives('nope');
  assert.deepEqual(directives, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('options.directives'));
});

test('parseOptionsDirectives passes undefined and null through as empty', () => {
  assert.deepEqual(parseOptionsDirectives(undefined), { directives: [], warnings: [] });
  assert.deepEqual(parseOptionsDirectives(null), { directives: [], warnings: [] });
});

test('parseOptionsDirectives warns when advisory text is truncated', () => {
  const long = 'z'.repeat(MAX_DIRECTIVE_TEXT + 5);
  const { directives, warnings } = parseOptionsDirectives([{ id: 'opt-long', text: long }]);
  assert.equal(directives[0].text.length, MAX_DIRECTIVE_TEXT);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("'opt-long'"));
  assert.ok(warnings[0].includes('truncated from'));
});

// ── Pure module: globToRegExp ──

test('globToRegExp matches basenames with a leading-dot glob', () => {
  const regex = globToRegExp('.env*');
  assert.ok(regex.test('.env'));
  assert.ok(regex.test('.env.local'));
  assert.ok(!regex.test('keep.env'));
});

test('globToRegExp keeps a directory prefix under a recursive segment', () => {
  const regex = globToRegExp('secrets/**');
  assert.ok(regex.test('secrets/credentials.json'));
  assert.ok(regex.test('secrets/a/b.pem'));
  assert.ok(!regex.test('src/secrets/credentials.json'));
});

test('globToRegExp lets a leading recursive segment match zero directories', () => {
  const regex = globToRegExp('**/*.pem');
  assert.ok(regex.test('key.pem'));
  assert.ok(regex.test('a/b/key.pem'));
});

test('globToRegExp keeps single stars inside one path segment', () => {
  const regex = globToRegExp('src/*.ts');
  assert.ok(regex.test('src/a.ts'));
  assert.ok(!regex.test('src/a/b.ts'));
});

test('globToRegExp treats a question mark as one character', () => {
  const regex = globToRegExp('file?.txt');
  assert.ok(regex.test('file1.txt'));
  assert.ok(!regex.test('file12.txt'));
});

test('globToRegExp matches paths case-insensitively', () => {
  const regex = globToRegExp('secrets/**');
  assert.ok(regex.test('Secrets/token.ts'));
  assert.ok(regex.test('SECRETS/a/b.pem'));
});

test('globToRegExp keeps multiple recursive segments segment-anchored', () => {
  const regex = globToRegExp('src/**/gen/**/x.ts');
  assert.ok(regex.test('src/gen/x.ts'));
  assert.ok(regex.test('src/a/gen/b/x.ts'));
  assert.ok(regex.test('src/a/b/gen/c/d/x.ts'));
  assert.ok(!regex.test('src/xgen/x.ts'));
  assert.ok(!regex.test('gen/x.ts'));
});

// ── Pure module: extractPolicyPaths (FR-028, FR-029) ──

test('extractPolicyPaths captures slash paths and dotfiles beyond the code-extension allowlist', () => {
  const paths = extractPolicyPaths({
    command: 'cat .env.local secrets/credentials.pem',
    path: 'config/production',
    count: 3,
  });
  assert.ok(paths.includes('.env.local'));
  assert.ok(paths.includes('secrets/credentials.pem'));
  assert.ok(paths.includes('config/production'));
});

test('extractPolicyPaths returns empty for absent or non-string arguments', () => {
  assert.deepEqual(extractPolicyPaths(undefined), []);
  assert.deepEqual(extractPolicyPaths({ count: 3, ok: true }), []);
});

// ── Pure module: compileEnforcement + evaluateEnforcement (FR-028) ──

test('compileEnforcement compiles paths and patterns, skipping invalid regexes', () => {
  const directives: Directive[] = [
    {
      id: 'no-secrets',
      text: NO_SECRETS_TEXT,
      enforce: [{ forbidPath: 'secrets/**' }, { forbidPattern: '(' }],
    },
  ];
  const { enforcement, warnings } = compileEnforcement(directives);
  assert.equal(enforcement.forbidPaths.length, 1);
  assert.equal(enforcement.forbidPatterns.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('no-secrets'));
});

test('evaluateEnforcement blocks a forbidden path with an actionable reason', () => {
  const { enforcement } = compileEnforcement([
    { id: 'no-secrets', text: NO_SECRETS_TEXT, enforce: [{ forbidPath: 'secrets/**' }] },
  ]);
  const verdict = evaluateEnforcement(
    enforcement,
    'bash',
    JSON.stringify({ command: 'cat secrets/credentials.json' }),
    ['secrets/credentials.json']
  );
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reason.includes("engineer directive 'no-secrets'"));
  assert.ok(verdict.reason.includes('secrets/credentials.json'));
  assert.ok(verdict.reason.includes(NO_SECRETS_TEXT));
});

test('evaluateEnforcement blocks a forbidden pattern case-insensitively', () => {
  const { enforcement } = compileEnforcement([
    { id: 'no-force-push', text: 'Never force-push.', enforce: [{ forbidPattern: 'git\\s+push\\s+--force' }] },
  ]);
  const verdict = evaluateEnforcement(
    enforcement,
    'bash',
    JSON.stringify({ command: 'GIT PUSH --FORCE' }),
    []
  );
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reason.includes('forbidden pattern'));
  assert.ok(verdict.reason.includes('Never force-push.'));
});

test('evaluateEnforcement allows when nothing matches and when rules are absent', () => {
  const { enforcement } = compileEnforcement([
    { id: 'no-secrets', text: NO_SECRETS_TEXT, enforce: [{ forbidPath: 'secrets/**' }] },
  ]);
  assert.deepEqual(
    evaluateEnforcement(enforcement, 'bash', '{}', []),
    { allowed: true, reason: '' }
  );
  const empty = compileEnforcement([{ id: 'advisory', text: 'be kind' }]).enforcement;
  assert.deepEqual(evaluateEnforcement(empty, 'bash', 'anything', ['secrets/x.json']), {
    allowed: true,
    reason: '',
  });
});

// ── Pure module: matchTriggers + activeDirectives (FR-029) ──

test('matchTriggers matches tool names case-insensitively', () => {
  const directives: Directive[] = [
    { id: 'bash-only', text: 'note', when: [{ tool: 'bash' }] },
    { id: 'unrelated', text: 'note', when: [{ tool: 'edit' }] },
    { id: 'always', text: 'note' },
  ];
  assert.deepEqual(matchTriggers(compileTriggers(directives), 'BASH', []), ['bash-only']);
});

test('matchTriggers matches argument paths against when-globs', () => {
  const triggers = compileTriggers([{ id: 'crypto', text: 'note', when: [{ path: 'src/crypto/**' }] }]);
  assert.deepEqual(matchTriggers(triggers, 'edit', ['src/crypto/aes.ts']), ['crypto']);
  assert.deepEqual(matchTriggers(triggers, 'edit', ['./src/crypto/aes.ts']), ['crypto']);
  assert.deepEqual(matchTriggers(triggers, 'edit', ['src/other/aes.ts']), []);
});

test('compileTriggers skips unconditioned directives and precompiles globs', () => {
  const triggers = compileTriggers([
    { id: 'always', text: 'note' },
    { id: 'mixed', text: 'note', when: [{ tool: 'Bash' }, { path: 'src/**' }] },
  ]);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].directiveId, 'mixed');
  assert.equal(triggers[0].rules[0].tool, 'bash');
  assert.ok(triggers[0].rules[1].pathRegex instanceof RegExp);
});

// ── Pure module: FR-079 matching helpers ──

test('matchesPaths matches the whole path or a slash-boundary suffix', () => {
  const regex = globToRegExp('secrets/**');
  assert.equal(matchesPaths(regex, ['src/a.ts', './secrets/token']), './secrets/token');
  assert.equal(matchesPaths(regex, ['~/secrets/token']), '~/secrets/token');
  assert.equal(matchesPaths(regex, ['/home/dev/proj/secrets/token']), '/home/dev/proj/secrets/token');
  assert.equal(matchesPaths(regex, ['src/secrets.ts', 'docs/secrets-faq']), undefined);
  assert.equal(matchesPaths(regex, []), undefined);
});

test('matchesPaths keeps leading-slash globs root-anchored and basename globs global', () => {
  assert.equal(matchesPaths(globToRegExp('/etc/**'), ['vendor/etc/conf']), undefined);
  assert.equal(matchesPaths(globToRegExp('/etc/**'), ['/etc/passwd']), '/etc/passwd');
  assert.equal(matchesPaths(globToRegExp('.env*'), ['deploy/.env.local']), 'deploy/.env.local');
});

test('extractDirectivePaths reads nested string values within its bounds', () => {
  assert.deepEqual(
    extractDirectivePaths({ edits: [{ filePath: 'secrets/token' }], meta: { target: { file: 'a/b.txt' } } }),
    ['secrets/token', 'a/b.txt']
  );
  assert.deepEqual(extractDirectivePaths({ command: 'cat ./x/y' }), ['./x/y']);
  assert.deepEqual(extractDirectivePaths(undefined), []);
  let deep: unknown = 'too/deep';
  for (let i = 0; i < MAX_NESTED_ARG_DEPTH + 2; i += 1) deep = [deep];
  assert.deepEqual(extractDirectivePaths({ deep }), []);
  const many = Array.from({ length: MAX_NESTED_ARG_STRINGS + 10 }, (_, i) => `p/${i}`);
  assert.equal(extractDirectivePaths({ many }).length, MAX_NESTED_ARG_STRINGS);
});

test('describeDirectiveSources names each directive with its file or options source', () => {
  const fileDirective: Directive = { id: 'no-secrets', text: 'x' };
  const optionDirective: Directive = { id: 'prefer-bun', text: 'y' };
  assert.equal(
    describeDirectiveSources([fileDirective, optionDirective], [fileDirective]),
    'no-secrets (no-secrets.md), prefer-bun (options)'
  );
  assert.equal(describeDirectiveSources([], []), '');
});

test('activeDirectives keeps unconditioned directives always active', () => {
  const directives: Directive[] = [
    { id: 'always', text: 'always text' },
    { id: 'cond', text: 'cond text', when: [{ tool: 'bash' }] },
  ];
  assert.deepEqual(activeDirectives(directives, []), [{ id: 'always', text: 'always text' }]);
  assert.deepEqual(activeDirectives(directives, ['cond']), [
    { id: 'always', text: 'always text' },
    { id: 'cond', text: 'cond text' },
  ]);
});

// ── Pure module: rendering (FR-030, FR-032) ──

test('renderDirectives renders the section and returns null when empty', () => {
  assert.equal(renderDirectives([]), null);
  const section = renderDirectives([{ id: 'no-secrets', text: NO_SECRETS_TEXT }]);
  assert.equal(section, `Directives:\n- no-secrets: ${NO_SECRETS_TEXT}`);
});

test('renderDirectives truncates beyond the fixed render budget with a note', () => {
  const directives = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, text: 'y'.repeat(200) }));
  const section = renderDirectives(directives);
  assert.ok(section !== null);
  assert.ok(section.length < 8000);
  assert.ok(section.includes('more directives omitted'));
  assert.ok(section.includes(`${MAX_DIRECTIVES_RENDER_BUDGET}`));
});

test('renderDirectivesAdvisory renders id-text lines without a header', () => {
  assert.equal(renderDirectivesAdvisory([]), null);
  const advisory = renderDirectivesAdvisory([{ id: 'no-secrets', text: NO_SECRETS_TEXT }]);
  assert.equal(advisory, `no-secrets: ${NO_SECRETS_TEXT}`);
});

// ── Memo integration (FR-030) ──

test('buildMemo renders directives between the goal and reminders', () => {
  const memo = buildMemo(
    {
      goal: 'ship the change',
      directives: [{ id: 'no-secrets', text: NO_SECRETS_TEXT }],
      reminders: [{ id: 'r1', text: 'use bash 4.5', addedAt: '2026-10-25T00:00:00.000Z' }],
      solvedItems: [{ tool: 'bash', outcome: 'tests passed' }],
      critiques: [{ text: 'arithmetic slipped', severity: 'minor', delivered: true }],
    },
    DEFAULT_MEMO_LIMITS
  );
  assert.ok(memo !== null);
  assert.ok(memo.includes(`Directives:\n- no-secrets: ${NO_SECRETS_TEXT}`));
  assert.ok(memo.indexOf('Session goal:') < memo.indexOf('Directives:'));
  assert.ok(memo.indexOf('Directives:') < memo.indexOf('Reminders:'));
  assert.ok(memo.indexOf('Reminders:') < memo.indexOf('Recently solved:'));
});

test('buildMemo omits the directives section when no directives are active', () => {
  const memo = buildMemo(
    { goal: 'g', reminders: [], solvedItems: [], critiques: [] },
    DEFAULT_MEMO_LIMITS
  );
  assert.equal(memo, 'Session goal:\ng');
});

test('buildMemo renders a directives-only memo', () => {
  const memo = buildMemo(
    { directives: [{ id: 'no-secrets', text: NO_SECRETS_TEXT }], solvedItems: [], critiques: [] },
    DEFAULT_MEMO_LIMITS
  );
  assert.equal(memo, `Directives:\n- no-secrets: ${NO_SECRETS_TEXT}`);
});

// ── Auditor integration (FR-031) ──

const AUDIT_CONFIG: AuditConfig = {
  auditorModel: 'mock/auditor-model',
  auditorVariant: 'low',
  stripMode: 'code_and_math',
  maxRegenerations: 2,
  blockRewardHacking: true,
  requireStepReferenceInTools: true,
};

test('runPeerAudit includes a directives section when text is provided', async () => {
  const prompts: string[] = [];
  const invokeModel: InvokeModel = async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ passed: true, failedStep: null, severity: null, critique: 'ok' });
  };
  const outcome = await runPeerAudit(
    ['x = 1 + 1 = 2'],
    AUDIT_CONFIG,
    invokeModel,
    undefined,
    `no-secrets: ${NO_SECRETS_TEXT}`
  );
  assert.equal(outcome.passed, true);
  assert.ok(prompts[0].includes('Engineer directives (flag steps that violate them):'));
  assert.ok(prompts[0].includes(NO_SECRETS_TEXT));
});

test('runPeerAudit preserves the prior prompt when no directives are configured', async () => {
  const prompts: string[] = [];
  const invokeModel: InvokeModel = async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ passed: true, failedStep: null, severity: null, critique: 'ok' });
  };
  await runPeerAudit(['x = 1 + 1 = 2'], AUDIT_CONFIG, invokeModel);
  assert.ok(!prompts[0].includes('Engineer directives'));
});

// ── Hook layer: loading, memo, guard, triggers (FR-026..FR-030, FR-032) ──

test('directive files load from the project directory into the memo', async () => {
  const dir = makeDirectiveDir({
    'no-secrets.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      sessionState.get('directives-load');
      const messages = await dispatchMemoTransform(hooks, 'directives-load');
      const memo = messageText(messages[1]);
      assert.equal(messages.length, 2);
      assert.ok(memo.includes('Directives:'));
      assert.ok(memo.includes(`- no-secrets: ${NO_SECRETS_TEXT}`));
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forbidden path blocks the tool call with the directive named', async () => {
  const dir = makeDirectiveDir({
    'no-secrets.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'guard-session', 'bash', { command: 'cat secrets/token.ts' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("Execution blocked: Tool 'bash' blocked by engineer directive 'no-secrets'"));
          assert.ok(error.message.includes('secrets/token.ts'));
          return true;
        }
      );
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forbidden pattern blocks the tool call case-insensitively', async () => {
  const dir = makeDirectiveDir({
    'no-force-push.md': directiveFile('Never force-push main.', {
      enforce: [{ forbidPattern: 'git\\s+push\\s+--force' }],
    }),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'pattern-session', 'bash', { command: 'git push --force origin main' }),
        /forbidden pattern 'git\\s\+push\\s\+--force'/
      );
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clean tool calls proceed while directives are configured', async () => {
  const dir = makeDirectiveDir({
    'no-secrets.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      await dispatchToolBefore(hooks, 'clean-session', 'bash', { command: 'bun test' });
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a trigger rule surfaces its directive in the memo after a matching call', async () => {
  const dir = makeDirectiveDir({
    'legacy-note.md': directiveFile('Explain migration constraints first.', {
      when: [{ path: 'src/legacy/**' }],
    }),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      sessionState.get('trigger-session');

      const before = await dispatchMemoTransform(hooks, 'trigger-session');
      assert.equal(before.length, 1);

      await dispatchToolBefore(hooks, 'trigger-session', 'edit', { path: 'src/legacy/queue.ts' });

      const after = await dispatchMemoTransform(hooks, 'trigger-session');
      assert.equal(after.length, 2);
      assert.ok(messageText(after[1]).includes('- legacy-note: Explain migration constraints first.'));
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a blocked call still records its trigger', async () => {
  const dir = makeDirectiveDir({
    'no-secrets.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES),
    'secrets-note.md': directiveFile('Ask the engineer for vault access.', {
      when: [{ path: 'secrets/**' }],
    }),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      sessionState.get('blocked-trigger-session');
      await assert.rejects(
        dispatchToolBefore(hooks, 'blocked-trigger-session', 'bash', { command: 'cat secrets/credentials.json' })
      );
      assert.ok(sessionState.get('blocked-trigger-session').triggeredDirectives.includes('secrets-note'));
      const messages = await dispatchMemoTransform(hooks, 'blocked-trigger-session');
      assert.equal(messages.length, 2);
      assert.ok(messageText(messages[1]).includes('- secrets-note: Ask the engineer for vault access.'));
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project without directives keeps the 2.1.0 behavior', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput('/tmp/supervisor-test'));
    sessionState.get('baseline-session');
    sessionState.get('baseline-session').goal = 'a goal';
    const messages = await dispatchMemoTransform(hooks, 'baseline-session');
    assert.equal(messages.length, 2);
    assert.ok(!messageText(messages[1]).includes('Directives:'));
    await dispatchToolBefore(hooks, 'baseline-session', 'bash', { command: 'bun test' });
    await hooks.dispose!();
  });
});

test('options.directives registers directives through the tuple channel', async () => {
  await withCleanSupervisorEnv(async () => {
    const hooks = await plugin.server(silentPluginInput('/tmp/supervisor-test'), {
      directives: [{ id: 'opt-directive', text: 'Prefer bun over node.', when: [{ tool: 'bash' }] }],
    });
    sessionState.get('options-session');
    await dispatchToolBefore(hooks, 'options-session', 'bash', { command: 'bun test' });
    const messages = await dispatchMemoTransform(hooks, 'options-session');
    assert.equal(messages.length, 2);
    assert.ok(messageText(messages[1]).includes('- opt-directive: Prefer bun over node.'));
    await hooks.dispose!();
  });
});

test('the directive count bound drops the overflow with a warning', async () => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= MAX_DIRECTIVES + 5; i += 1) {
    files[`d${String(i).padStart(2, '0')}.md`] = `policy ${i}`;
  }
  const dir = makeDirectiveDir(files);
  try {
    await withCleanSupervisorEnv(async () => {
      const { input, logEntries } = recordingPluginInput(dir);
      const hooks = await plugin.server(input);
      sessionState.get('cap-session');
      const messages = await dispatchMemoTransform(hooks, 'cap-session');
      assert.equal(messages.length, 2);
      const memo = messageText(messages[1]);
      assert.ok(memo.includes('- d20: policy 20'));
      assert.ok(!memo.includes('d21'));
      await hooks.dispose!();
      // FR-052: the overflow warning rides the server log, not stderr.
      assert.ok(logEntries.some((entry) => entry.level === 'warn' && entry.message.includes('beyond the cap')));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the event-hook audit prompt carries the directives advisory', async () => {
  const dir = makeDirectiveDir({
    'no-secrets.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const prompts: string[] = [];
      const input = silentPluginInput(dir);
      (input.client as { session: Record<string, unknown> }).session.prompt = async (
        request: unknown
      ) => {
        prompts.push(JSON.stringify(request));
        return {
          data: {
            info: {},
            parts: [
              {
                type: 'text',
                text: JSON.stringify({ passed: true, failedStep: null, severity: null, critique: 'ok' }),
              },
            ],
          },
        };
      };
      const hooks = await plugin.server(input);
      await dispatchPart(hooks, completedReasoningPart({ sessionID: 'audit-directives-session' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(prompts.length, 1);
      assert.ok(prompts[0].includes('Engineer directives (flag steps that violate them):'));
      assert.ok(prompts[0].includes(NO_SECRETS_TEXT));
      assert.ok(sessionState.get('audit-directives-session').verifiedSteps.length === 1);
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dotfile forbidPath blocks paths the extension allowlist cannot see', async () => {
  const dir = makeDirectiveDir({
    'no-dotenv.md': directiveFile('Never read environment files.', {
      enforce: [{ forbidPath: '.env*' }],
    }),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'dotenv-session', 'bash', { command: 'cat .env.local' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("engineer directive 'no-dotenv'"));
          assert.ok(error.message.includes('.env.local'));
          return true;
        }
      );
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a case-different path still matches a forbidden glob', async () => {
  const dir = makeDirectiveDir({
    'no-secrets.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      await assert.rejects(
        dispatchToolBefore(hooks, 'case-session', 'bash', { command: 'cat Secrets/token.ts' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("engineer directive 'no-secrets'"));
          return true;
        }
      );
      await hooks.dispose!();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable directive file is skipped while the rest still load', async () => {
  if (process.getuid && process.getuid() === 0) return;
  const dir = makeDirectiveDir({
    'good.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES),
    'locked.md': 'unreadable policy',
  });
  const locked = path.join(dir, '.opencode', 'supervisor', 'directives', 'locked.md');
  fs.chmodSync(locked, 0o000);
  try {
    await withCleanSupervisorEnv(async () => {
      const { input, logEntries } = recordingPluginInput(dir);
      const hooks = await plugin.server(input);
      sessionState.get('unreadable-session');
      const messages = await dispatchMemoTransform(hooks, 'unreadable-session');
      assert.equal(messages.length, 2);
      assert.ok(messageText(messages[1]).includes('- good:'));
      await hooks.dispose!();
      assert.ok(
        logEntries.some((entry) => entry.level === 'warn' && entry.message.includes("directive file 'locked.md' unreadable"))
      );
    });
  } finally {
    fs.chmodSync(locked, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the first-recorded trigger for a directive is logged once', async () => {
  const dir = makeDirectiveDir({
    'legacy-note.md': directiveFile('Explain migration constraints first.', {
      when: [{ path: 'src/legacy/**' }],
    }),
  });
  try {
    await withCleanSupervisorEnv(async () => {
      const { input, logEntries } = recordingPluginInput(dir);
      const hooks = await plugin.server(input);
      sessionState.get('trigger-log-session');
      await dispatchToolBefore(hooks, 'trigger-log-session', 'edit', { path: 'src/legacy/queue.ts' });
      await dispatchToolBefore(hooks, 'trigger-log-session', 'edit', { path: 'src/legacy/other.ts' });
      await hooks.dispose!();
      // FR-052: the trigger observation rides the server log, not stdout.
      const hits = logEntries.filter(
        (entry) => entry.level === 'info' && entry.message.includes("directive 'legacy-note' triggered by tool 'edit'")
      );
      assert.equal(hits.length, 1);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── FR-079: directive path anchoring regressions (#17 round 2, #55) ──

/** Runs one guarded call against a single-directive project; resolves to the block message or null. */
async function guardOutcome(rules: object, tool: string, args: unknown): Promise<string | null> {
  const dir = makeDirectiveDir({ 'policy.md': directiveFile('Policy text.', rules) });
  try {
    let outcome: string | null = null;
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      try {
        await dispatchToolBefore(hooks, 'anchor-session', tool, args);
      } catch (error) {
        outcome = error instanceof Error ? error.message : String(error);
      }
      await hooks.dispose!();
    });
    return outcome;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one call against a single when-path directive; resolves to whether it triggered. */
async function triggerOutcome(glob: string, tool: string, args: unknown): Promise<boolean> {
  const dir = makeDirectiveDir({ 'note.md': directiveFile('Trigger note.', { when: [{ path: glob }] }) });
  try {
    let triggered = false;
    await withCleanSupervisorEnv(async () => {
      const hooks = await plugin.server(silentPluginInput(dir));
      await dispatchToolBefore(hooks, 'anchor-trigger-session', tool, args);
      triggered = sessionState.get('anchor-trigger-session').triggeredDirectives.includes('note');
      sessionState.cleanup('anchor-trigger-session');
      await hooks.dispose!();
    });
    return triggered;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('forbidPath blocks a ./-prefixed spelling (FR-079)', async () => {
  const outcome = await guardOutcome(NO_SECRETS_RULES, 'read', { filePath: './secrets/token' });
  assert.ok(outcome?.includes("engineer directive 'policy'"), String(outcome));
});

test('forbidPath blocks a ~-prefixed spelling (FR-079)', async () => {
  const outcome = await guardOutcome(NO_SECRETS_RULES, 'bash', { command: 'cat ~/secrets/token' });
  assert.ok(outcome?.includes("engineer directive 'policy'"), String(outcome));
});

test('forbidPath blocks an absolute spelling (FR-079)', async () => {
  const outcome = await guardOutcome(NO_SECRETS_RULES, 'read', { filePath: '/home/dev/proj/secrets/token' });
  assert.ok(outcome?.includes("engineer directive 'policy'"), String(outcome));
});

test('forbidPath blocks a path nested inside array arguments (FR-079)', async () => {
  const outcome = await guardOutcome(NO_SECRETS_RULES, 'multiedit', {
    edits: [{ filePath: 'secrets/token', oldString: 'a', newString: 'b' }],
  });
  assert.ok(outcome?.includes("engineer directive 'policy'"), String(outcome));
});

test('forbidPath still passes unrelated look-alike paths (FR-079)', async () => {
  assert.equal(await guardOutcome(NO_SECRETS_RULES, 'read', { filePath: 'src/secrets.ts' }), null);
  assert.equal(await guardOutcome(NO_SECRETS_RULES, 'read', { filePath: 'docs/secrets-faq' }), null);
});

test('a leading-slash forbidPath stays anchored at the root (FR-079)', async () => {
  const rules = { enforce: [{ forbidPath: '/etc/**' }] };
  assert.equal(await guardOutcome(rules, 'read', { filePath: 'vendor/etc/conf' }), null);
  const outcome = await guardOutcome(rules, 'read', { filePath: '/etc/passwd' });
  assert.ok(outcome?.includes("engineer directive 'policy'"), String(outcome));
});

test('when-path globs trigger on a ./-prefixed spelling (FR-079)', async () => {
  assert.equal(await triggerOutcome('src/crypto/**', 'edit', { filePath: './src/crypto/aes.ts' }), true);
});

test('when-path globs trigger on a ~-prefixed spelling (FR-079)', async () => {
  assert.equal(await triggerOutcome('src/crypto/**', 'bash', { command: 'cat ~/src/crypto/aes.ts' }), true);
});

test('when-path globs trigger on an absolute spelling (FR-079)', async () => {
  assert.equal(await triggerOutcome('src/crypto/**', 'edit', { filePath: '/home/dev/proj/src/crypto/aes.ts' }), true);
});

test('when-path globs trigger on a nested argument path (FR-079)', async () => {
  assert.equal(
    await triggerOutcome('src/crypto/**', 'multiedit', { edits: [{ filePath: 'src/crypto/aes.ts' }] }),
    true
  );
});

test('when-path globs ignore unrelated spellings (FR-079)', async () => {
  assert.equal(await triggerOutcome('src/crypto/**', 'edit', { filePath: './src/other/aes.ts' }), false);
});

test('directive files past the read cap are never parsed (FR-079)', async () => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= MAX_DIRECTIVE_FILES; i += 1) {
    files[`d${String(i).padStart(2, '0')}.md`] = `policy ${i}`;
  }
  const broken = `x\n\n\`\`\`supervisor\n{"enforce": [}\n\`\`\`\n`;
  files['z1.md'] = broken;
  files['z2.md'] = broken;
  const dir = makeDirectiveDir(files);
  try {
    await withCleanSupervisorEnv(async () => {
      const { input, logEntries } = recordingPluginInput(dir);
      const hooks = await plugin.server(input);
      await dispatchToolBefore(hooks, 'file-cap-session', 'bash', { command: 'bun test' });
      await hooks.dispose!();
      const warnings = logEntries.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
      assert.ok(!warnings.some((message) => message.includes('z1.md') || message.includes('z2.md')));
      assert.ok(warnings.some((message) => message.includes(`2 directive file(s) beyond the read cap of ${MAX_DIRECTIVE_FILES}`)));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the identity line names loaded directives and their sources (FR-079)', async () => {
  const dir = makeDirectiveDir({ 'no-secrets.md': directiveFile(NO_SECRETS_TEXT, NO_SECRETS_RULES) });
  const saved = { ...logIdentityState };
  try {
    await withCleanSupervisorEnv(async () => {
      logIdentityState.identityLogged = false;
      logIdentityState.identitySaidNoModel = false;
      const { input, logEntries } = recordingPluginInput(dir);
      const hooks = await plugin.server(input, {
        directives: [{ id: 'prefer-bun', text: 'Prefer bun over node.' }],
      });
      await dispatchToolBefore(hooks, 'identity-session', 'bash', { command: 'bun test' });
      await hooks.dispose!();
      const identity = logEntries.find((entry) => entry.level === 'info' && entry.message.includes(' loaded ('));
      assert.ok(identity, 'identity line logged');
      assert.ok(identity.message.includes('directives: 2 [no-secrets (no-secrets.md), prefer-bun (options)]'), identity.message);
    });
  } finally {
    Object.assign(logIdentityState, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
