/**
 * External-access supervision (FR-080..FR-089): pure-module tests for
 * detection, classification, grants, the gate decision, requests,
 * and question replies, plus hook-layer tests for the gate, the
 * request_access tool, question-flow minting, and the memo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
