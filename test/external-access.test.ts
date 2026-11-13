/**
 * External-access supervision (FR-080..FR-089): pure-module tests for
 * detection, classification, grants, the gate decision, requests,
 * and question replies, plus hook-layer tests for the gate, the
 * request_access tool, question-flow minting, and the memo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hooks, PluginInput, ToolContext } from '@opencode-ai/plugin';

import plugin, { configPathState, resolveHookConfig, sessionState } from '../index.ts';
import { validateSupervisorConfig } from '../src/config-file.ts';
import { sanitizeNonGlobalTier } from '../src/guard-profiles.ts';
import { buildMemo } from '../src/memo.ts';
import { recordingPluginInput, silentClientSurface } from './mocks.ts';

import {
  accessNeedsGrant,
  appendRecent,
  buildAccessQuestion,
  accessQuestionText,
  classifyToolAccess,
  decideExternalAccess,
  expandGrantPath,
  findExternalPaths,
  grantCovers,
  isExternalPath,
  isGateNeutralTool,
  matchQuestionReplies,
  MAX_EXTERNAL_GRANTS,
  normalizeAbsolutePath,
  parseAccessReply,
  parseExternalGrants,
  prepareAccessRequest,
  renderExternalAccess,
  resolvePathToken,
  type AccessRequest,
  type ExternalGrant,
  type PathContext,
} from '../src/external-access.ts';
import { expiryActive } from '../src/gates.ts';
import { checkProtectedState, extractArgPaths } from '../src/tool-guard.ts';
import { extractPolicyPaths } from '../src/directives.ts';

const CTX: PathContext = { base: '/work/proj', roots: ['/work/proj'], home: '/home/u' };

const grant = (overrides: Partial<ExternalGrant> = {}): ExternalGrant => ({
  path: '/data/shared',
  mode: 'read-write',
  lifetime: 'file',
  ...overrides,
});

const request = (overrides: Partial<AccessRequest> = {}): AccessRequest => {
  const base = { id: 'ax1', path: '/data/shared', mode: 'read-write' as const, justification: 'sync fixtures' };
  const merged = { ...base, ...overrides };
  return { ...merged, question: overrides.question ?? accessQuestionText(merged.id, merged.path, merged.mode, merged.justification) };
};

// ── Classification (FR-081) ──

test('classifyToolAccess treats read builtins as read-class and everything else as write-class', () => {
  for (const tool of ['read', 'glob', 'grep', 'list', 'lsp']) {
    assert.equal(classifyToolAccess(tool), 'read', tool);
  }
  for (const tool of ['bash', 'edit', 'write', 'patch', 'multiedit', 'apply_patch', 'fs_read_file', 'mystery']) {
    assert.equal(classifyToolAccess(tool), 'write', tool);
  }
});

test('isGateNeutralTool exempts only tools that act on no file', () => {
  for (const tool of ['question', 'task', 'todowrite', 'webfetch']) {
    assert.equal(isGateNeutralTool(tool), true, tool);
  }
  for (const tool of ['bash', 'read', 'write', 'fs_write']) {
    assert.equal(isGateNeutralTool(tool), false, tool);
  }
});

test('accessNeedsGrant gates writes always and reads only under the gate policy', () => {
  assert.equal(accessNeedsGrant('write', 'allow'), true);
  assert.equal(accessNeedsGrant('read', 'allow'), false);
  assert.equal(accessNeedsGrant('read', 'gate'), true);
});

// ── Containment (FR-080) ──

test('normalizeAbsolutePath collapses traversal without climbing above the root and keeps case and dots', () => {
  assert.equal(normalizeAbsolutePath('/a/./b/../c'), '/a/c');
  assert.equal(normalizeAbsolutePath('/../../etc'), '/etc');
  assert.equal(normalizeAbsolutePath('/A/.proj//x'), '/A/.proj/x');
  assert.equal(normalizeAbsolutePath('/'), '/');
});

test('resolvePathToken expands home spellings, resolves relative paths, and flags unresolvable ones', () => {
  assert.equal(resolvePathToken('~/notes.md', CTX.base, CTX.home), '/home/u/notes.md');
  assert.equal(resolvePathToken('~', CTX.base, CTX.home), '/home/u');
  assert.equal(resolvePathToken('$HOME/notes.md', CTX.base, CTX.home), '/home/u/notes.md');
  assert.equal(resolvePathToken('${HOME}/x', CTX.base, CTX.home), '/home/u/x');
  assert.equal(resolvePathToken('$PWD/src/a.ts', CTX.base, CTX.home), '/work/proj/src/a.ts');
  assert.equal(resolvePathToken('src/a.ts', CTX.base, CTX.home), '/work/proj/src/a.ts');
  assert.equal(resolvePathToken('../other/a.ts', CTX.base, CTX.home), '/work/other/a.ts');
  assert.equal(resolvePathToken('~bob/x', CTX.base, CTX.home), '~bob/x');
  assert.equal(resolvePathToken('$TMPDIR/x', CTX.base, CTX.home), '$TMPDIR/x');
  assert.equal(resolvePathToken('$f/x', CTX.base, CTX.home), null);
  assert.equal(resolvePathToken('$PATH', CTX.base, CTX.home), null);
});

test('isExternalPath: outside every root is external; the root itself, its children, and device paths are not', () => {
  assert.equal(isExternalPath('/etc/hosts', CTX.roots), true);
  assert.equal(isExternalPath('/work/proj', CTX.roots), false);
  assert.equal(isExternalPath('/work/proj/src/a.ts', CTX.roots), false);
  assert.equal(isExternalPath('/work/project-other/a.ts', CTX.roots), true, 'a sibling sharing the prefix is outside');
  assert.equal(isExternalPath('/dev/null', CTX.roots), false);
  assert.equal(isExternalPath('/dev/fd/3', CTX.roots), false);
  assert.equal(isExternalPath('$TMPDIR/x', CTX.roots), true, 'unresolvable tokens are external');
});

test('findExternalPaths: absolute-outside targets are external', () => {
  assert.deepEqual(findExternalPaths('write', { filePath: '/etc/hosts', content: 'x' }, CTX), ['/etc/hosts']);
});

test('findExternalPaths: ~ and $HOME spellings in bash resolve to home', () => {
  assert.deepEqual(findExternalPaths('bash', { command: 'cat ~/notes.md > $HOME/copy.md' }, CTX), [
    '/home/u/notes.md',
    '/home/u/copy.md',
  ]);
});

test('findExternalPaths: relative paths stay internal; ../ traversal escapes', () => {
  assert.deepEqual(findExternalPaths('edit', { filePath: 'src/a.ts', oldString: 'a', newString: 'b' }, CTX), []);
  assert.deepEqual(findExternalPaths('edit', { filePath: 'src/../../other/a.ts' }, CTX), ['/work/other/a.ts']);
  assert.deepEqual(findExternalPaths('bash', { command: 'cd .. && rm -rf build' }, CTX), ['/work']);
});

test('findExternalPaths: the root itself is internal', () => {
  assert.deepEqual(findExternalPaths('list', { path: '/work/proj' }, CTX), []);
});

test('findExternalPaths skips content keys, grep patterns, URLs, bash descriptions, and /dev/null', () => {
  assert.deepEqual(findExternalPaths('write', { filePath: 'src/a.ts', content: 'see /etc/hosts' }, CTX), []);
  assert.deepEqual(findExternalPaths('grep', { pattern: '/api/v1', path: 'src' }, CTX), []);
  assert.deepEqual(findExternalPaths('bash', { command: 'curl -s https://example.com/a/b 2>/dev/null', description: 'Fetch /etc data' }, CTX), []);
});

test('findExternalPaths: bash workdir is both checked and the base for relative tokens', () => {
  assert.deepEqual(findExternalPaths('bash', { command: 'ls src/a', workdir: '/srv/app' }, CTX), ['/srv/app', '/srv/app/src/a']);
  assert.deepEqual(findExternalPaths('bash', { command: 'ls src/a', workdir: '/work/proj' }, CTX), []);
});

test('findExternalPaths: glued and flag-style spellings are found (extractPolicyPaths and = splitting)', () => {
  assert.deepEqual(findExternalPaths('bash', { command: 'scp host:/etc/x .' }, CTX).includes('/etc/x'), true);
  assert.deepEqual(findExternalPaths('bash', { command: 'tool --out=/tmp/out.json' }, CTX), ['/tmp/out.json']);
});

test('findExternalPaths: unknown tools scan every non-content key; worktree roots count as inside', () => {
  assert.deepEqual(findExternalPaths('fs_write', { destination: '/var/x', content: '/etc/y' }, CTX), ['/var/x']);
  const ctx: PathContext = { ...CTX, roots: ['/work/proj/sub', '/work/proj'] };
  assert.deepEqual(findExternalPaths('write', { filePath: '/work/proj/a.ts' }, ctx), []);
});

// ── Grants (FR-083, FR-086) ──

test('expandGrantPath expands home spellings and rejects relative paths', () => {
  assert.equal(expandGrantPath('~/shared', '/home/u'), '/home/u/shared');
  assert.equal(expandGrantPath('$HOME/shared', '/home/u'), '/home/u/shared');
  assert.equal(expandGrantPath('/data/../data/x', '/home/u'), '/data/x');
  assert.equal(expandGrantPath('shared', '/home/u'), null);
});

test('parseExternalGrants fails closed on invalid JSON or a non-array', () => {
  assert.match(parseExternalGrants('{nope', '/h').error ?? '', /not valid JSON/);
  assert.match(parseExternalGrants('{"path": "/x"}', '/h').error ?? '', /not a JSON array/);
});

test('parseExternalGrants skips malformed entries and keeps the most recent grants', () => {
  const parsed = parseExternalGrants(
    JSON.stringify([
      { path: '/a', mode: 'read' },
      { path: 'relative', mode: 'read' },
      { path: '/b', mode: 'write' },
      { mode: 'read' },
      'junk',
      { path: '~/c', mode: 'read-write', note: ' n ', expires: '2026-12-31' },
    ]),
    '/home/u'
  );
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.grants, [
    { path: '/a', mode: 'read', lifetime: 'file' },
    { path: '/home/u/c', mode: 'read-write', lifetime: 'file', note: 'n', expires: '2026-12-31' },
  ]);
  const many = Array.from({ length: MAX_EXTERNAL_GRANTS + 5 }, (_, i) => ({ path: `/p${i}`, mode: 'read' }));
  const bounded = parseExternalGrants(JSON.stringify(many), '/h').grants;
  assert.equal(bounded.length, MAX_EXTERNAL_GRANTS);
  assert.equal(bounded[0]?.path, '/p5');
});

test('grantCovers: literal grants cover descendants, glob grants cover matches and their descendants', () => {
  assert.equal(grantCovers(grant(), '/data/shared/a/b.json', 'write'), true);
  assert.equal(grantCovers(grant(), '/data/shared', 'write'), true);
  assert.equal(grantCovers(grant(), '/data/shared-other/x', 'write'), false);
  assert.equal(grantCovers(grant({ path: '/data/*/cache' }), '/data/a/cache/f.bin', 'write'), true);
  assert.equal(grantCovers(grant({ path: '/data/*/cache' }), '/data/a/other/f.bin', 'write'), false);
  assert.equal(grantCovers(grant({ path: '/' }), '/anything/at/all', 'write'), true);
  assert.equal(grantCovers(grant(), '$TMPDIR/x', 'write'), false, 'unresolvable tokens are never covered');
});

test('grantCovers: a read grant never covers a write call; read-write covers both', () => {
  assert.equal(grantCovers(grant({ mode: 'read' }), '/data/shared/x', 'write'), false);
  assert.equal(grantCovers(grant({ mode: 'read' }), '/data/shared/x', 'read'), true);
  assert.equal(grantCovers(grant({ mode: 'read-write' }), '/data/shared/x', 'read'), true);
});

test('grantCovers honors end-of-day expiry and rejects unparseable dates', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  assert.equal(grantCovers(grant({ expires: '2026-11-13' }), '/data/shared/x', 'write', now), true);
  assert.equal(grantCovers(grant({ expires: '2026-11-12' }), '/data/shared/x', 'write', now), false);
  assert.equal(grantCovers(grant({ expires: 'soon' }), '/data/shared/x', 'write', now), false);
  assert.equal(expiryActive(undefined, now), true);
});

test('decideExternalAccess blocks uncovered paths with an actionable reason', () => {
  const decision = decideExternalAccess({
    tool: 'write',
    accessClass: 'write',
    paths: ['/data/shared/out.json'],
    grants: [],
    fileError: null,
    requestToolAvailable: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /write access to \/data\/shared\/out\.json outside the project root/);
  assert.match(decision.reason, /request_access/);
  assert.match(decision.reason, /"mode":"read-write"/);
  assert.match(decision.reason, /\.opencode\/supervisor\/external-access\.json/);
});

test('decideExternalAccess names the file error when the grants file is unreadable (fail closed)', () => {
  const decision = decideExternalAccess({
    tool: 'write',
    accessClass: 'write',
    paths: ['/x/y'],
    grants: [],
    fileError: 'grants file is not valid JSON: boom',
    requestToolAvailable: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /could not be read \(grants file is not valid JSON: boom\); external access fails closed/);
});

test('decideExternalAccess asks for an absolute spelling when a token is unresolvable', () => {
  const decision = decideExternalAccess({
    tool: 'bash',
    accessClass: 'write',
    paths: ['$TMPDIR/x'],
    grants: [grant({ path: '/' })],
    fileError: null,
    requestToolAvailable: true,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /Spell the path absolutely/);
});

test('decideExternalAccess prefers lasting grants over once grants and reports once grants used', () => {
  const once = grant({ lifetime: 'once', path: '/data/shared/out.json' });
  const lasting = decideExternalAccess({
    tool: 'write',
    accessClass: 'write',
    paths: ['/data/shared/out.json'],
    grants: [once, grant({ lifetime: 'session' })],
    fileError: null,
    requestToolAvailable: true,
  });
  assert.equal(lasting.allowed, true);
  assert.deepEqual(lasting.onceGrantsUsed, []);
  const onlyOnce = decideExternalAccess({
    tool: 'write',
    accessClass: 'write',
    paths: ['/data/shared/out.json', '/data/shared/out.json.bak'],
    grants: [grant({ lifetime: 'once', path: '/data/shared' })],
    fileError: null,
    requestToolAvailable: true,
  });
  assert.equal(onlyOnce.allowed, true);
  assert.equal(onlyOnce.onceGrantsUsed.length, 1, 'one once grant spent per call');
});

// ── Requests and replies (FR-084, FR-085, FR-087) ──

test('prepareAccessRequest resolves and validates a request', () => {
  const ok = prepareAccessRequest({ path: '~/shared', mode: 'read', justification: '  read   the docs ' }, CTX);
  assert.deepEqual(ok, { ok: true, path: '/home/u/shared', mode: 'read', justification: 'read the docs' });
  const rejections: [Record<string, unknown>, RegExp][] = [
    [{ path: '/x', mode: 'write', justification: 'j' }, /Unknown mode/],
    [{ path: ' ', mode: 'read', justification: 'j' }, /Path is empty/],
    [{ path: '/x', mode: 'read', justification: '' }, /Justification is empty/],
    [{ path: 'src', mode: 'read', justification: 'j' }, /inside the project root/],
    [{ path: '/', mode: 'read', justification: 'j' }, /too broad/],
    [{ path: '~', mode: 'read', justification: 'j' }, /too broad/],
    [{ path: '$TMPDIR/x', mode: 'read', justification: 'j' }, /absolute path/],
  ];
  for (const [args, pattern] of rejections) {
    const result = prepareAccessRequest(args, CTX);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.ok ? '' : result.error, pattern);
  }
  const long = prepareAccessRequest({ path: '/x', mode: 'read', justification: 'j'.repeat(400) }, CTX);
  assert.equal(long.ok && long.justification.length, 300);
});

test('buildAccessQuestion words a single-choice question with fixed options and no free text', () => {
  const question = buildAccessQuestion(request());
  assert.match(question.question, /^\[supervisor access request ax1\] The agent requests READ-WRITE access outside the project root: \/data\/shared\./);
  assert.deepEqual(
    question.options.map((option) => option.label),
    ['Allow once', 'Allow for this session', 'Deny']
  );
  assert.equal(question.multiple, false);
  assert.equal(question.custom, false);
  assert.ok(question.header.length <= 30);
});

test('parseAccessReply maps the reply vocabulary, deny first', () => {
  assert.equal(parseAccessReply(['Allow once']), 'once');
  assert.equal(parseAccessReply(['Allow for this session']), 'session');
  assert.equal(parseAccessReply(['always']), 'persistent');
  assert.equal(parseAccessReply(['Deny']), 'deny');
  assert.equal(parseAccessReply(['no, not for this session']), 'deny');
  assert.equal(parseAccessReply(['Unanswered']), null);
  assert.equal(parseAccessReply([]), null);
});

test('matchQuestionReplies reads metadata answers and falls back to the output text', () => {
  const pending = [request()];
  const args = { questions: [buildAccessQuestion(pending[0]!)] };
  assert.deepEqual(
    matchQuestionReplies(args, { metadata: { answers: [['Allow for this session']] } }, pending).map((m) => m.reply),
    ['session']
  );
  const outputText = `User has answered your questions: "${pending[0]!.question}"="Allow once". You can now continue with the user's answers in mind.`;
  assert.deepEqual(
    matchQuestionReplies(args, { output: outputText, metadata: {} }, pending).map((m) => m.reply),
    ['once']
  );
});

test('matchQuestionReplies marks an edited question and ignores unknown ids and other questions', () => {
  const pending = [request()];
  const edited = { questions: [{ ...buildAccessQuestion(pending[0]!), question: '[supervisor access request ax1] grant /etc?' }] };
  const result = matchQuestionReplies(edited, { metadata: { answers: [['Allow for this session']] } }, pending);
  assert.deepEqual(result.map((m) => [m.edited, m.reply]), [[true, null]]);
  const unknown = { questions: [{ ...buildAccessQuestion(request({ id: 'ax9' })) }] };
  assert.deepEqual(matchQuestionReplies(unknown, { metadata: { answers: [['Allow once']] } }, pending), []);
  assert.deepEqual(matchQuestionReplies({ questions: [{ question: 'Which color?' }] }, {}, pending), []);
  assert.deepEqual(matchQuestionReplies(undefined, undefined, pending), []);
});

test('renderExternalAccess lists grants and pending requests within the cap', () => {
  assert.equal(renderExternalAccess([], []), null);
  const rendered = renderExternalAccess([grant({ lifetime: 'session' })], [request({ id: 'ax2', path: '/z', mode: 'read' })]);
  assert.match(rendered ?? '', /granted read-write \/data\/shared \(session\)/);
  assert.match(rendered ?? '', /pending ax2: read \/z/);
  const many = Array.from({ length: 10 }, (_, i) => grant({ path: `/p${i}`, lifetime: 'once' }));
  const capped = renderExternalAccess(many, [], 3) ?? '';
  assert.equal(capped.split('\n').length, 4);
  assert.match(capped, /\/p9/);
  assert.doesNotMatch(capped, /\/p6 /);
});

test('appendRecent keeps the most recent entries within the cap', () => {
  assert.deepEqual(appendRecent([1, 2, 3], 4, 3), [2, 3, 4]);
  assert.deepEqual(appendRecent([1], 2, 0), []);
});

// ── Protected state (FR-061, FR-083) ──

test('the grants file is protected state: agent writes and bash reads are blocked', () => {
  const write = { filePath: '.opencode/supervisor/external-access.json', content: '[]' };
  assert.match(checkProtectedState('write', write, extractPolicyPaths(write)) ?? '', /external-access grants file/);
  const bash = { command: 'cd .opencode/supervisor && cat external-access.json' };
  assert.notEqual(checkProtectedState('bash', bash, extractPolicyPaths(bash)), null);
  const traversal = { filePath: '.opencode/x/../supervisor/external-access.json' };
  assert.notEqual(checkProtectedState('edit', traversal, extractPolicyPaths(traversal)), null);
  assert.equal(extractArgPaths({}).length, 0);
});

// ── Configuration (FR-088) ──

test('validateSupervisorConfig accepts externalAccess and rejects wrong types', () => {
  assert.deepEqual(validateSupervisorConfig({ externalAccess: { enabled: true, readPolicy: 'gate', extra: 1 } }), {
    config: { externalAccess: { enabled: true, readPolicy: 'gate' } },
    error: null,
  });
  assert.match(validateSupervisorConfig({ externalAccess: true }).error ?? '', /"externalAccess" must be an object/);
  assert.match(validateSupervisorConfig({ externalAccess: { enabled: 'yes' } }).error ?? '', /enabled" must be a boolean/);
  assert.match(validateSupervisorConfig({ externalAccess: { readPolicy: 'deny' } }).error ?? '', /readPolicy" must be one of allow, gate/);
});

test('resolveHookConfig resolves externalAccess through the tiers and defaults to off', async () => {
  await withCleanAccessEnv(async () => {
    assert.deepEqual(resolveHookConfig(undefined, {}).externalAccess, { enabled: false, readPolicy: 'allow' });
    assert.deepEqual(
      resolveHookConfig(undefined, {
        project: { externalAccess: { readPolicy: 'gate' } },
        global: { externalAccess: { enabled: true, readPolicy: 'allow' } },
      }).externalAccess,
      { enabled: true, readPolicy: 'gate' }
    );
    process.env.OPENCODE_SUPERVISOR_EXTERNAL_ACCESS = 'false';
    process.env.OPENCODE_SUPERVISOR_EXTERNAL_ACCESS_READ_POLICY = 'gate';
    assert.deepEqual(resolveHookConfig(undefined, { project: { externalAccess: { enabled: true } } }).externalAccess, {
      enabled: false,
      readPolicy: 'gate',
    });
  });
});

test('under lockGuards no tier above the global file can disable the gate or relax the read policy', async () => {
  await withCleanAccessEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_EXTERNAL_ACCESS = 'false';
    process.env.OPENCODE_SUPERVISOR_EXTERNAL_ACCESS_READ_POLICY = 'allow';
    const resolved = resolveHookConfig(
      { config: { plugins: { 'opencode-supervisor': { externalAccess: { enabled: false } } } } },
      { global: { lockGuards: true, externalAccess: { enabled: true, readPolicy: 'gate' } } }
    );
    assert.deepEqual(resolved.externalAccess, { enabled: true, readPolicy: 'gate' });
    const sanitized = sanitizeNonGlobalTier({ externalAccess: { enabled: false, readPolicy: 'allow' } }, 'project file', true);
    assert.deepEqual(sanitized.config.externalAccess, {});
    assert.equal(sanitized.warnings.length, 2);
    const tightening = sanitizeNonGlobalTier({ externalAccess: { enabled: true, readPolicy: 'gate' } }, 'project file', true);
    assert.deepEqual(tightening.config.externalAccess, { enabled: true, readPolicy: 'gate' });
    assert.deepEqual(sanitizeNonGlobalTier({ externalAccess: { enabled: false } }, 'p', false).config.externalAccess, {
      enabled: false,
    });
  });
});

test('buildMemo renders an external-access section on its own and leaves memos without it unchanged', () => {
  assert.equal(buildMemo({ solvedItems: [], critiques: [], externalAccess: null }), null);
  assert.equal(buildMemo({ solvedItems: [], critiques: [], externalAccess: 'External access:\n- x' }), 'External access:\n- x');
  assert.equal(buildMemo({ goal: 'g', solvedItems: [], critiques: [] }), 'Session goal:\ng');
});

// ── Hook layer (FR-082..FR-089) ──

/** Saves and clears every OPENCODE_SUPERVISOR_* variable, isolates XDG_CONFIG_HOME and HOME around `run`. */
async function withCleanAccessEnv(run: (xdg: string, home: string) => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('OPENCODE_SUPERVISOR_')) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  }
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedHome = process.env.HOME;
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-xdg-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-home-'));
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.HOME = home;
  // The guard lock also consults the account's home-directory config
  // (FR-075); point it at the throwaway home so a host file cannot leak.
  const savedAccountHome = configPathState.accountHome;
  configPathState.accountHome = () => home;
  try {
    await run(xdg, home);
  } finally {
    configPathState.accountHome = savedAccountHome;
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('OPENCODE_SUPERVISOR_')) delete process.env[name];
    }
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const ENABLED = { externalAccess: { enabled: true } };

/** Starts the plugin on a temp project; `grants` (raw text) seeds the grants file. */
async function startPlugin(
  config: Record<string, unknown> | null = ENABLED,
  setup: { grants?: string; projectConfig?: Record<string, unknown> } = {}
): Promise<{ hooks: Hooks; dir: string; logEntries: Array<{ level: string; message: string }> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-access-'));
  fs.mkdirSync(path.join(dir, '.opencode', 'supervisor'), { recursive: true });
  if (setup.grants !== undefined) {
    fs.writeFileSync(path.join(dir, '.opencode', 'supervisor', 'external-access.json'), setup.grants);
  }
  if (setup.projectConfig !== undefined) {
    fs.writeFileSync(path.join(dir, '.opencode', 'supervisor', 'config.json'), JSON.stringify(setup.projectConfig));
  }
  const { input, logEntries } = recordingPluginInput(dir);
  const hooks = await plugin.server(input, config === null ? undefined : ({ config } as never));
  return { hooks, dir, logEntries };
}

let accessSessionSeq = 0;
const newSession = (): string => `access-session-${++accessSessionSeq}`;

const callTool = (hooks: Hooks, sessionID: string, tool: string, args: Record<string, unknown>): Promise<void> =>
  hooks['tool.execute.before']!({ tool, sessionID, callID: 'call-1' }, { args });

const toolContext = (sessionID: string): ToolContext => ({ sessionID }) as unknown as ToolContext;

const requestAccess = (hooks: Hooks, sessionID: string, args: Record<string, unknown>): Promise<string> =>
  hooks.tool!.request_access!.execute(args as never, toolContext(sessionID)) as Promise<string>;

/** The question payload a request_access result carries. */
const questionPayload = (result: string): { questions: Record<string, unknown>[] } =>
  JSON.parse(result.split('\n')[1] ?? '{}');

/** Completes a relayed question with the engineer's answer; returns the output record. */
async function answerQuestion(
  hooks: Hooks,
  sessionID: string,
  args: unknown,
  answer: string,
  viaMetadata = true
): Promise<{ title: string; output: string; metadata: unknown }> {
  const questions = (args as { questions: Array<{ question: string }> }).questions;
  const output = {
    title: 'Asked 1 question',
    output: `User has answered your questions: ${questions.map((q) => `"${q.question}"="${answer}"`).join(', ')}. You can now continue with the user's answers in mind.`,
    metadata: viaMetadata ? { answers: [[answer]] } : {},
  };
  await hooks['tool.execute.after']!({ tool: 'question', sessionID, callID: 'q-1', args }, output);
  return output;
}

/** A session message in the messages-transform payload shape, and the memo dispatch. */
async function memoText(hooks: Hooks, sessionID: string): Promise<string> {
  const messages: unknown[] = [
    { info: { id: 'msg-1', sessionID, role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'turn' }] },
  ];
  const dispatch = hooks['experimental.chat.messages.transform'] as
    | ((input: unknown, output: unknown) => Promise<void>)
    | undefined;
  await dispatch?.(undefined, { messages });
  return messages
    .map((message) => ((message as { parts?: Array<{ text?: unknown }> }).parts ?? []).map((part) => String(part.text)).join('\n'))
    .join('\n');
}

test('with no externalAccess config, behavior is unchanged: five tools, external writes pass, no memo section (FR-089)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks, logEntries } = await startPlugin(null);
    assert.deepEqual(Object.keys(hooks.tool!).sort(), ['forget_reminder', 'recall', 'remind_me', 'report', 'request_audit']);
    const sessionID = newSession();
    await callTool(hooks, sessionID, 'write', { filePath: '/etc/hosts', content: 'x' });
    await callTool(hooks, sessionID, 'bash', { command: 'cat /etc/hosts > /tmp/hosts.copy' });
    assert.doesNotMatch(await memoText(hooks, sessionID), /External access/);
    assert.equal(logEntries.some((entry) => /external-access/.test(entry.message)), false);
  });
});

test('an external write without a grant is blocked with an actionable reason; internal writes pass (FR-082)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks, logEntries } = await startPlugin();
    assert.ok(hooks.tool!.request_access, 'request_access registers when enabled');
    const sessionID = newSession();
    await assert.rejects(
      callTool(hooks, sessionID, 'write', { filePath: '/data/shared/out.json', content: '{}' }),
      (error: Error) =>
        /blocked by external-access supervision: write access to \/data\/shared\/out\.json outside the project root/.test(error.message) &&
        /request_access/.test(error.message) &&
        /\{"path":"\/data\/shared\/out\.json","mode":"read-write"\}/.test(error.message) &&
        /\.opencode\/supervisor\/external-access\.json/.test(error.message)
    );
    assert.ok(logEntries.some((entry) => entry.level === 'error' && /blocked tool 'write'/.test(entry.message)));
    await callTool(hooks, sessionID, 'write', { filePath: 'src/a.ts', content: 'x' });
  });
});

test('external reads pass under readPolicy allow and are gated under readPolicy gate (FR-082)', async () => {
  await withCleanAccessEnv(async () => {
    const allow = await startPlugin();
    await allow.hooks['tool.execute.before']!({ tool: 'read', sessionID: newSession(), callID: 'c' }, { args: { filePath: '/data/shared/in.json' } });
    const gate = await startPlugin({ externalAccess: { enabled: true, readPolicy: 'gate' } });
    await assert.rejects(
      callTool(gate.hooks, newSession(), 'read', { filePath: '/data/shared/in.json' }),
      /read access to \/data\/shared\/in\.json/
    );
  });
});

test('bash touching an external path is write-class, even to read; /dev/null and URLs are not paths (FR-081)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin();
    const sessionID = newSession();
    await assert.rejects(callTool(hooks, sessionID, 'bash', { command: 'cat /etc/hosts' }), /write access to \/etc\/hosts/);
    await assert.rejects(callTool(hooks, sessionID, 'bash', { command: 'cat ~/notes.md' }), /notes\.md/);
    await assert.rejects(callTool(hooks, sessionID, 'bash', { command: 'ls ../sibling/' }), /outside the project root/);
    await callTool(hooks, sessionID, 'bash', { command: 'ls src/ 2>/dev/null && curl -s https://example.com/a/b' });
    // Tools that act on no file are never gated.
    await callTool(hooks, sessionID, 'webfetch', { url: 'https://example.com/etc/passwd' });
    await callTool(hooks, sessionID, 'task', { prompt: 'Look at /etc/hosts', description: 'x' });
  });
});

test('file grants: read-write allows, a read grant never covers a write, expiry ends a grant (FR-083)', async () => {
  await withCleanAccessEnv(async () => {
    const grants = JSON.stringify([
      { path: '/data/shared', mode: 'read-write' },
      { path: '/data/readonly', mode: 'read' },
      { path: '/data/old', mode: 'read-write', expires: '2000-01-01' },
    ]);
    const { hooks } = await startPlugin({ externalAccess: { enabled: true, readPolicy: 'gate' } }, { grants });
    const sessionID = newSession();
    await callTool(hooks, sessionID, 'write', { filePath: '/data/shared/a/out.json', content: '{}' });
    await callTool(hooks, sessionID, 'read', { filePath: '/data/readonly/in.json' });
    await assert.rejects(
      callTool(hooks, sessionID, 'write', { filePath: '/data/readonly/in.json', content: '{}' }),
      /write access to \/data\/readonly\/in\.json/
    );
    await assert.rejects(callTool(hooks, sessionID, 'write', { filePath: '/data/old/x.json', content: '{}' }), /\/data\/old\/x\.json/);
  });
});

test('a corrupt grants file fails closed, naming the error (FR-083)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin(ENABLED, { grants: '[{"path": "/data/shared", "mode": "read-write"' });
    await assert.rejects(
      callTool(hooks, newSession(), 'write', { filePath: '/data/shared/out.json', content: '{}' }),
      /grants file could not be read \(grants file is not valid JSON.*external access fails closed/
    );
  });
});

test('the agent cannot self-grant: writing the grants file is blocked as protected state (FR-083)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin();
    await assert.rejects(
      callTool(hooks, newSession(), 'write', {
        filePath: '.opencode/supervisor/external-access.json',
        content: '[{"path": "/", "mode": "read-write"}]',
      }),
      /external-access grants file is engineer-authored state/
    );
    await assert.rejects(
      callTool(hooks, newSession(), 'bash', { command: 'echo [] > .opencode/supervisor/external-access.json' }),
      /engineer-authored state/
    );
  });
});

test('request_access records a pending request, returns the question to relay, and grants nothing (FR-084)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks, logEntries } = await startPlugin();
    const sessionID = newSession();
    const result = await requestAccess(hooks, sessionID, { path: '/data/shared', mode: 'read-write', justification: 'Sync fixtures.' });
    assert.match(result, /^Access request ax1 recorded — nothing is granted yet/);
    const payload = questionPayload(result);
    const question = payload.questions[0] as { question: string; options: Array<{ label: string }>; custom: boolean };
    assert.match(question.question, /^\[supervisor access request ax1\] The agent requests READ-WRITE access outside the project root: \/data\/shared\./);
    assert.deepEqual(question.options.map((o) => o.label), ['Allow once', 'Allow for this session', 'Deny']);
    assert.equal(question.custom, false);
    assert.equal(sessionState.get(sessionID).pendingAccessRequests.length, 1);
    assert.ok(logEntries.some((entry) => /external-access request ax1: read-write \/data\/shared/.test(entry.message)));
    await assert.rejects(callTool(hooks, sessionID, 'write', { filePath: '/data/shared/x.json', content: '{}' }), /needs an engineer grant/);
    // A repeat returns the same pending request; internal paths need nothing.
    assert.match(await requestAccess(hooks, sessionID, { path: '/data/shared', mode: 'read-write', justification: 'again' }), /ax1/);
    assert.equal(sessionState.get(sessionID).pendingAccessRequests.length, 1);
    assert.match(await requestAccess(hooks, sessionID, { path: 'src', mode: 'read', justification: 'x' }), /inside the project root/);
    assert.match(await requestAccess(hooks, sessionID, { path: '/x', mode: 'all', justification: 'x' }), /Unknown mode/);
  });
});

test('request_access reports an already-covered path instead of asking', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin(ENABLED, { grants: JSON.stringify([{ path: '/data/shared', mode: 'read-write' }]) });
    const sessionID = newSession();
    assert.match(
      await requestAccess(hooks, sessionID, { path: '/data/shared/sub', mode: 'read', justification: 'x' }),
      /already granted/
    );
    assert.equal(sessionState.get(sessionID).pendingAccessRequests.length, 0);
  });
});

test('request_access is inert in auditor side sessions', async () => {
  await withCleanAccessEnv(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-access-'));
    const parked: Array<(response: unknown) => void> = [];
    const input = {
      client: {
        session: {
          create: async () => ({ data: { id: 'auditor-side-access' } }),
          prompt: () => new Promise((resolve) => parked.push(resolve)),
          promptAsync: async () => ({}),
          abort: async () => ({}),
          delete: async () => ({}),
        },
        ...silentClientSurface,
      },
      directory: dir,
    };
    const hooks = await plugin.server(input as unknown as PluginInput, { config: ENABLED } as never);
    const run = hooks.event!({
      event: {
        type: 'message.part.updated',
        properties: { part: { id: 'p1', sessionID: newSession(), messageID: 'm1', type: 'reasoning', text: 'x = 2 * 3 = 6', time: { start: 1, end: 2 } } },
      },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(parked.length, 1);
    assert.equal(
      await requestAccess(hooks, 'auditor-side-access', { path: '/data/x', mode: 'read', justification: 'x' }),
      'Console tools are not available in supervisor side sessions.'
    );
    assert.equal(sessionState.peek('auditor-side-access'), undefined);
    parked[0]!({ data: { info: {}, parts: [{ type: 'text', text: '{"passed":true,"failedStep":null,"severity":null,"critique":"ok"}' }] } });
    await run;
  });
});

test('the engineer allowing a relayed question for the session mints a grant; the retry passes (FR-085)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks, logEntries } = await startPlugin();
    const sessionID = newSession();
    await assert.rejects(callTool(hooks, sessionID, 'write', { filePath: '/data/shared/out.json', content: '{}' }));
    const payload = questionPayload(await requestAccess(hooks, sessionID, { path: '/data/shared', mode: 'read-write', justification: 'Sync.' }));
    const output = await answerQuestion(hooks, sessionID, payload, 'Allow for this session');
    assert.match(output.output, /\[supervisor\] access request ax1 granted: read-write \/data\/shared \(this session\)/);
    assert.ok(logEntries.some((entry) => /grant minted from request ax1: read-write \/data\/shared \(session\)/.test(entry.message)));
    await callTool(hooks, sessionID, 'write', { filePath: '/data/shared/out.json', content: '{}' });
    await callTool(hooks, sessionID, 'bash', { command: 'cp a.json /data/shared/b.json' });
    assert.equal(sessionState.get(sessionID).pendingAccessRequests.length, 0);
    // Other sessions are unaffected.
    await assert.rejects(callTool(hooks, newSession(), 'write', { filePath: '/data/shared/out.json', content: '{}' }));
  });
});

test('a read-mode grant from the question flow never covers a write', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin({ externalAccess: { enabled: true, readPolicy: 'gate' } });
    const sessionID = newSession();
    const payload = questionPayload(await requestAccess(hooks, sessionID, { path: '/data/shared', mode: 'read', justification: 'Read docs.' }));
    await answerQuestion(hooks, sessionID, payload, 'Allow for this session');
    await callTool(hooks, sessionID, 'read', { filePath: '/data/shared/doc.md' });
    await assert.rejects(callTool(hooks, sessionID, 'write', { filePath: '/data/shared/doc.md', content: 'x' }), /write access/);
  });
});

test('a once grant allows exactly one call and is not spent by a blocked call (FR-086)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks, logEntries } = await startPlugin();
    const sessionID = newSession();
    const payload = questionPayload(await requestAccess(hooks, sessionID, { path: '/data/shared/out.json', mode: 'read-write', justification: 'One write.' }));
    // The answer arrives through the output text when metadata is absent.
    await answerQuestion(hooks, sessionID, payload, 'Allow once', false);
    // A call that also touches an uncovered path is blocked and spends nothing.
    await assert.rejects(callTool(hooks, sessionID, 'bash', { command: 'cp /etc/hosts /data/shared/out.json' }), /\/etc\/hosts/);
    assert.equal(sessionState.get(sessionID).externalGrants.length, 1);
    await callTool(hooks, sessionID, 'write', { filePath: '/data/shared/out.json', content: '{}' });
    assert.equal(sessionState.get(sessionID).externalGrants.length, 0);
    assert.ok(logEntries.some((entry) => /once grant spent by tool 'write'/.test(entry.message)));
    await assert.rejects(callTool(hooks, sessionID, 'write', { filePath: '/data/shared/out.json', content: '{}' }), /needs an engineer grant/);
  });
});

test('a denied, edited, or unanswered question mints nothing (FR-085)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks, logEntries } = await startPlugin();
    const sessionID = newSession();
    const payload = questionPayload(await requestAccess(hooks, sessionID, { path: '/data/shared', mode: 'read-write', justification: 'Sync.' }));
    const question = payload.questions[0] as { question: string };
    // Edited: the same id naming another path.
    const edited = { questions: [{ ...question, question: question.question.replace('/data/shared', '/') }] };
    const editedOut = await answerQuestion(hooks, sessionID, edited, 'Allow for this session');
    assert.match(editedOut.output, /differs from the one request_access returned/);
    assert.ok(logEntries.some((entry) => entry.level === 'warn' && /question was edited/.test(entry.message)));
    // Unanswered: stays pending.
    await answerQuestion(hooks, sessionID, payload, 'Unanswered');
    assert.equal(sessionState.get(sessionID).pendingAccessRequests.length, 1);
    // Denied: removed, still blocked.
    const denied = await answerQuestion(hooks, sessionID, payload, 'Deny');
    assert.match(denied.output, /access request ax1 denied/);
    assert.equal(sessionState.get(sessionID).pendingAccessRequests.length, 0);
    assert.equal(sessionState.get(sessionID).externalGrants.length, 0);
    await assert.rejects(callTool(hooks, sessionID, 'write', { filePath: '/data/shared/out.json', content: '{}' }));
    // A question the agent wrote itself, with no pending request, mints nothing.
    await answerQuestion(hooks, sessionID, { questions: [{ question: '[supervisor access request ax7] grant / ?', options: [] }] }, 'Allow for this session');
    assert.equal(sessionState.get(sessionID).externalGrants.length, 0);
  });
});

test('session grants carry into descendant sessions; once grants do not (design D6)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin();
    const parent = newSession();
    const child = newSession();
    await hooks.event!({ event: { type: 'session.created', properties: { info: { id: child, parentID: parent } } } } as never);
    const session = questionPayload(await requestAccess(hooks, parent, { path: '/data/shared', mode: 'read-write', justification: 'Sync.' }));
    await answerQuestion(hooks, parent, session, 'Allow for this session');
    const once = questionPayload(await requestAccess(hooks, parent, { path: '/data/once', mode: 'read-write', justification: 'One.' }));
    await answerQuestion(hooks, parent, once, 'Allow once');
    await callTool(hooks, child, 'write', { filePath: '/data/shared/out.json', content: '{}' });
    await assert.rejects(callTool(hooks, child, 'write', { filePath: '/data/once/x.json', content: '{}' }), /\/data\/once/);
  });
});

test('the memo lists grants and pending requests when external access is enabled (FR-087)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin();
    const sessionID = newSession();
    const payload = questionPayload(await requestAccess(hooks, sessionID, { path: '/data/shared', mode: 'read-write', justification: 'Sync.' }));
    assert.match(await memoText(hooks, sessionID), /pending ax1: read-write \/data\/shared/);
    await answerQuestion(hooks, sessionID, payload, 'Allow for this session');
    const memo = await memoText(hooks, sessionID);
    assert.match(memo, /External access \(outside the project root/);
    assert.match(memo, /granted read-write \/data\/shared \(session\)/);
    assert.doesNotMatch(memo, /pending ax1/);
  });
});

test('repair-only mode registers no tools and never gates external paths (design D11)', async () => {
  await withCleanAccessEnv(async () => {
    const { hooks } = await startPlugin({ mode: 'repair-only', externalAccess: { enabled: true } });
    assert.equal(hooks.tool, undefined);
    await callTool(hooks, newSession(), 'write', { filePath: '/data/shared/out.json', content: '{}' });
  });
});

test('the environment can enable external access', async () => {
  await withCleanAccessEnv(async () => {
    process.env.OPENCODE_SUPERVISOR_EXTERNAL_ACCESS = 'true';
    const { hooks } = await startPlugin(null);
    assert.ok(hooks.tool!.request_access);
    await assert.rejects(callTool(hooks, newSession(), 'edit', { filePath: '/data/x.ts', oldString: 'a', newString: 'b' }));
  });
});

test('a project config cannot turn off a gate the locked global file enables (FR-088)', async () => {
  await withCleanAccessEnv(async (xdg) => {
    const globalDir = path.join(xdg, 'opencode', 'supervisor');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'config.json'), JSON.stringify({ lockGuards: true, externalAccess: { enabled: true } }));
    const locked = await startPlugin(null, { projectConfig: { externalAccess: { enabled: false } } });
    await assert.rejects(callTool(locked.hooks, newSession(), 'write', { filePath: '/data/x.json', content: '{}' }));
    assert.ok(locked.hooks.tool!.request_access);
    // Without the lock, the project file wins.
    fs.writeFileSync(path.join(globalDir, 'config.json'), JSON.stringify({ externalAccess: { enabled: true } }));
    const unlocked = await startPlugin(null, { projectConfig: { externalAccess: { enabled: false } } });
    await callTool(unlocked.hooks, newSession(), 'write', { filePath: '/data/x.json', content: '{}' });
  });
});
