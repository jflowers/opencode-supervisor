import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemo,
  DEFAULT_MEMO_LIMITS,
  normalizeMemoLimits,
  type CritiqueRecord,
  type MemoLimits,
  type SolvedItem,
} from '../src/memo.ts';
import { takeMostRecent } from '../src/records.ts';

function solvedItem(n: number): SolvedItem {
  return { tool: 'write', outcome: `outcome-${n}` };
}

function critiqueRecord(n: number): CritiqueRecord {
  return { text: `critique-${n}`, severity: 'minor', delivered: true };
}

test('DEFAULT_MEMO_LIMITS caps solved items at 5, critiques at 3, and reminders at 10', () => {
  assert.deepEqual(DEFAULT_MEMO_LIMITS, { maxSolvedItems: 5, maxCritiques: 3, maxReminders: 10, maxReports: 5 });
});

test('buildMemo renders goal, solved items, and critiques in order', () => {
  const memo = buildMemo({
    goal: 'Ship the supervision memo',
    solvedItems: [{ tool: 'write', outcome: 'created src/memo.ts' }],
    critiques: [{ text: 'Step 2 arithmetic error.', severity: 'minor', delivered: true }],
  });

  assert.ok(memo !== null);
  assert.ok(memo.includes('Session goal:'));
  assert.ok(memo.includes('Ship the supervision memo'));
  assert.ok(memo.includes('Recently solved:'));
  assert.ok(memo.includes('- write: created src/memo.ts'));
  assert.ok(memo.includes('Recent critiques:'));
  assert.ok(memo.includes('Step 2 arithmetic error.'));
  assert.ok(memo.indexOf('Session goal:') < memo.indexOf('Recently solved:'));
  assert.ok(memo.indexOf('Recently solved:') < memo.indexOf('Recent critiques:'));
});

test('buildMemo bounds solved items and critiques to the most recent entries', () => {
  const memo = buildMemo({
    goal: 'Long session',
    solvedItems: Array.from({ length: 7 }, (_, i) => solvedItem(i)),
    critiques: Array.from({ length: 5 }, (_, i) => critiqueRecord(i)),
  });

  assert.ok(memo !== null);
  const lines = memo.split('\n');
  assert.equal(lines.filter((line) => line.includes('outcome-')).length, DEFAULT_MEMO_LIMITS.maxSolvedItems);
  assert.equal(lines.filter((line) => line.includes('critique-')).length, DEFAULT_MEMO_LIMITS.maxCritiques);

  // FR-017: the most recent entries (end of array) survive the cap.
  for (let i = 2; i < 7; i++) {
    assert.ok(memo.includes(`outcome-${i}`));
  }
  assert.ok(!memo.includes('outcome-0'));
  assert.ok(!memo.includes('outcome-1'));

  for (let i = 2; i < 5; i++) {
    assert.ok(memo.includes(`critique-${i}`));
  }
  assert.ok(!memo.includes('critique-0'));
  assert.ok(!memo.includes('critique-1'));
});

test('buildMemo omits headers for sections with no content', () => {
  const goalOnly = buildMemo({ goal: 'Only a goal', solvedItems: [], critiques: [] });
  assert.ok(goalOnly !== null);
  assert.ok(goalOnly.includes('Session goal:'));
  assert.ok(goalOnly.includes('Only a goal'));
  assert.ok(!goalOnly.includes('Recently solved:'));
  assert.ok(!goalOnly.includes('Recent critiques:'));

  const solvedOnly = buildMemo({
    solvedItems: [{ tool: 'bash', outcome: 'bun test green' }],
    critiques: [],
  });
  assert.ok(solvedOnly !== null);
  assert.ok(!solvedOnly.includes('Session goal:'));
  assert.ok(solvedOnly.includes('Recently solved:'));
  assert.ok(solvedOnly.includes('- bash: bun test green'));
  assert.ok(!solvedOnly.includes('Recent critiques:'));

  const critiquesOnly = buildMemo({
    solvedItems: [],
    critiques: [{ text: 'Scope drift beyond the goal.', severity: 'minor', delivered: false }],
  });
  assert.ok(critiquesOnly !== null);
  assert.ok(!critiquesOnly.includes('Session goal:'));
  assert.ok(!critiquesOnly.includes('Recently solved:'));
  assert.ok(critiquesOnly.includes('Recent critiques:'));
  assert.ok(critiquesOnly.includes('Scope drift beyond the goal.'));
});

test('buildMemo returns null when there is nothing to show', () => {
  assert.equal(buildMemo({ solvedItems: [], critiques: [] }), null);
  assert.equal(buildMemo({ goal: '   \n\t ', solvedItems: [], critiques: [] }), null);
});

test('buildMemo enforces the solved-item and critique caps independently', () => {
  const solvedOver = buildMemo({
    solvedItems: Array.from({ length: 6 }, (_, i) => solvedItem(i)),
    critiques: [critiqueRecord(0), critiqueRecord(1)],
  });
  assert.ok(solvedOver !== null);
  const solvedOverLines = solvedOver.split('\n');
  assert.equal(solvedOverLines.filter((line) => line.includes('outcome-')).length, 5);
  assert.equal(solvedOverLines.filter((line) => line.includes('critique-')).length, 2);
  assert.ok(!solvedOver.includes('outcome-0'));

  const critiquesOver = buildMemo({
    solvedItems: [solvedItem(0)],
    critiques: Array.from({ length: 4 }, (_, i) => critiqueRecord(i)),
  });
  assert.ok(critiquesOver !== null);
  const critiquesOverLines = critiquesOver.split('\n');
  assert.equal(critiquesOverLines.filter((line) => line.includes('outcome-')).length, 1);
  assert.equal(critiquesOverLines.filter((line) => line.includes('critique-')).length, 3);
  assert.ok(!critiquesOver.includes('critique-0'));
});

test('buildMemo honors custom limits over the defaults', () => {
  const memo = buildMemo(
    {
      goal: 'Custom caps',
      solvedItems: Array.from({ length: 3 }, (_, i) => solvedItem(i)),
      critiques: Array.from({ length: 2 }, (_, i) => critiqueRecord(i)),
    },
    { maxSolvedItems: 2, maxCritiques: 1, maxReminders: 2, maxReports: 2 }
  );

  assert.ok(memo !== null);
  const lines = memo.split('\n');
  assert.equal(lines.filter((line) => line.includes('outcome-')).length, 2);
  assert.equal(lines.filter((line) => line.includes('critique-')).length, 1);
  assert.ok(!memo.includes('outcome-0'));
  assert.ok(memo.includes('outcome-1'));
  assert.ok(memo.includes('outcome-2'));
  assert.ok(!memo.includes('critique-0'));
  assert.ok(memo.includes('critique-1'));
});

test('buildMemo renders delivered and withheld critiques distinguishably', () => {
  const memo = buildMemo({
    solvedItems: [],
    critiques: [
      { text: 'Step 3 off-by-one bound.', severity: 'minor', delivered: true },
      { text: 'Reward hacking: disabling tests.', severity: 'severe', delivered: false },
    ],
  });

  assert.ok(memo !== null);
  assert.ok(memo.includes('[minor, delivered] Step 3 off-by-one bound.'));
  assert.ok(memo.includes('[severe, withheld] Reward hacking: disabling tests.'));
});

test('takeMostRecent keeps the tail, copies, and yields nothing at a cap of zero or less', () => {
  const items = [1, 2, 3, 4];
  assert.deepEqual(takeMostRecent(items, 2), [3, 4]);
  const all = takeMostRecent(items, 10);
  assert.deepEqual(all, items);
  assert.notEqual(all, items);
  assert.deepEqual(takeMostRecent(items, 0), []);
  assert.deepEqual(takeMostRecent(items, -1), []);
  assert.deepEqual(takeMostRecent([], 3), []);
});

test('normalizeMemoLimits fills missing or non-finite caps with defaults (FR-077)', () => {
  assert.deepEqual(normalizeMemoLimits(undefined), DEFAULT_MEMO_LIMITS);
  assert.deepEqual(
    normalizeMemoLimits({ maxSolvedItems: 2, maxCritiques: Number.NaN, maxReminders: 0 }),
    { maxSolvedItems: 2, maxCritiques: DEFAULT_MEMO_LIMITS.maxCritiques, maxReminders: 0, maxReports: DEFAULT_MEMO_LIMITS.maxReports }
  );
});

test('buildMemo keeps default report and reminder caps for older limits objects (FR-077)', () => {
  const oldLimits = { maxSolvedItems: 5, maxCritiques: 3 } as unknown as MemoLimits;
  const agentReports = Array.from({ length: DEFAULT_MEMO_LIMITS.maxReports + 3 }, (_, i) => ({
    kind: 'note' as const,
    text: `report-${i}`,
    addedAt: '2026-11-13T00:00:00.000Z',
  }));
  const reminders = Array.from({ length: DEFAULT_MEMO_LIMITS.maxReminders + 2 }, (_, i) => ({
    id: `r${i}`,
    text: `reminder-${i}`,
    addedAt: '2026-11-13T00:00:00.000Z',
  }));
  const memo = buildMemo({ agentReports, reminders, solvedItems: [], critiques: [] }, oldLimits);
  assert.ok(memo !== null);
  assert.equal((memo.match(/\[note\]/g) ?? []).length, DEFAULT_MEMO_LIMITS.maxReports);
  assert.ok(!memo.includes('report-0'));
  assert.equal((memo.match(/reminder-/g) ?? []).length, DEFAULT_MEMO_LIMITS.maxReminders);
});
