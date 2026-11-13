/**
 * Supervision Memo Builder
 * Formats the session's supervision context — the goal (FR-013), the
 * active engineer directives (FR-030), the agent's reminders
 * (FR-020), the solved-items log (FR-014), the agent's self-reported
 * events (FR-036), and the prior-critiques log (FR-015) — into the
 * bounded memo delivered as one trailing user message per user
 * prompt via `experimental.chat.messages.transform` (FR-016).
 * Each section appears only when it has content; a session
 * with nothing to show yields no memo at all, so the payload is
 * left untouched. Solved items, critiques, reminders, and agent
 * reports are capped at configurable maximums, keeping the most recent
 * entries, so the memo cannot grow without limit across a long session
 * (FR-017, FR-023, FR-035); directives carry their own fixed render
 * budget (FR-032). Pure module: no OpenCode
 * imports, no I/O, no session state — the hook layer (design D4) owns the
 * Maps and passes plain data in.
 */

import { renderReports, type AgentReport } from './console.ts';
import { renderDirectives, type DirectiveText } from './directives.ts';
import { takeMostRecent, type CritiqueRecord, type SolvedItem } from './records.ts';
import { renderReminders, type Reminder } from './reminders.ts';

// The record shapes live in the records leaf module (AP-006: it breaks
// the memo ↔ console cycle); re-exported so existing imports keep working.
export type { CritiqueRecord, SolvedItem } from './records.ts';

export interface MemoInput {
  /** Session goal — the first user message (FR-013); absent until captured. */
  goal?: string;
  /** Active engineer directives (FR-030); optional so directive-less callers are unchanged. */
  directives?: DirectiveText[];
  /** Agent-set reminders (FR-020); optional so reminder-less callers are unchanged. */
  reminders?: Reminder[];
  /** Agent self-reported events (FR-034); optional so report-less callers are unchanged. */
  agentReports?: AgentReport[];
  solvedItems: SolvedItem[];
  critiques: CritiqueRecord[];
}

export interface MemoLimits {
  /** Cap on solved items shown in the memo (FR-017). */
  maxSolvedItems: number;
  /** Cap on critiques shown in the memo (FR-017). */
  maxCritiques: number;
  /** Cap on reminders stored and shown (FR-023). */
  maxReminders: number;
  /** Cap on agent reports stored and shown (FR-035, FR-036). */
  maxReports: number;
}

export const DEFAULT_MEMO_LIMITS: MemoLimits = {
  maxSolvedItems: 5,
  maxCritiques: 3,
  maxReminders: 10,
  maxReports: 5,
};

/**
 * Normalizes caller-supplied memo limits at runtime (FR-077): every
 * field that is missing or not a finite number takes its
 * DEFAULT_MEMO_LIMITS value. JavaScript callers written before
 * `maxReminders` and `maxReports` existed pass objects without them;
 * unnormalized, those caps were `undefined` and bounded nothing.
 *
 * @param limits The caller's limits, possibly partial or malformed.
 * @returns A complete limits object.
 */
export function normalizeMemoLimits(limits: Partial<MemoLimits> | undefined): MemoLimits {
  const pick = (key: keyof MemoLimits): number => {
    const value = limits?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MEMO_LIMITS[key];
  };
  return {
    maxSolvedItems: pick('maxSolvedItems'),
    maxCritiques: pick('maxCritiques'),
    maxReminders: pick('maxReminders'),
    maxReports: pick('maxReports'),
  };
}

/**
 * Builds the supervision memo (FR-016): the session goal, the agent's
 * reminders (FR-020), recently solved items (FR-014), the agent's
 * self-reported events (FR-036), and recent critiques (FR-015), each
 * section present only when it has content. Reminders, solved items,
 * agent reports, and critiques are bounded to their most recent entries
 * within the configured caps (FR-017, FR-023, FR-035), each cap applied
 * once; limits are normalized first (FR-077). Reminder ids
 * render with their text so `forget_reminder` is usable from the
 * memo alone (FR-021). Both
 * delivered and withheld critiques render, marked with severity and
 * delivery so the agent can tell them apart. When there is nothing to
 * show — no goal, no reminders, and no entries in either log — the memo
 * is null and the caller leaves the system prompt unchanged.
 *
 * @param input The session's supervision state: goal, reminders, solved items, critiques.
 * @param limits Caps on reminders, solved items, and critiques shown; defaults to DEFAULT_MEMO_LIMITS.
 * @returns The memo text with sections joined by blank lines, or null when empty.
 */
export function buildMemo(input: MemoInput, limits: Partial<MemoLimits> = DEFAULT_MEMO_LIMITS): string | null {
  const caps = normalizeMemoLimits(limits);
  const goal = input.goal?.trim();
  const directives = input.directives ?? [];
  const solvedItems = takeMostRecent(input.solvedItems, caps.maxSolvedItems);
  const critiques = takeMostRecent(input.critiques, caps.maxCritiques);
  // The section renderers own the reminder and report caps, so each
  // applies exactly once; null means the section is empty.
  const remindersSection = renderReminders(input.reminders ?? [], caps.maxReminders);
  const reportsSection = renderReports(input.agentReports ?? [], caps.maxReports);
  const directivesSection = directives.length > 0 ? renderDirectives(directives) : null;

  if (
    !goal &&
    directives.length === 0 &&
    remindersSection === null &&
    solvedItems.length === 0 &&
    reportsSection === null &&
    critiques.length === 0
  ) {
    return null;
  }

  const sections: string[] = [];

  if (goal) {
    sections.push(`Session goal:\n${goal}`);
  }

  if (directivesSection !== null) {
    sections.push(directivesSection);
  }

  if (remindersSection !== null) {
    sections.push(remindersSection);
  }

  if (solvedItems.length > 0) {
    const lines = solvedItems.map((item) => `- ${item.tool}: ${item.outcome}`);
    sections.push(`Recently solved:\n${lines.join('\n')}`);
  }

  if (reportsSection !== null) {
    sections.push(reportsSection);
  }

  if (critiques.length > 0) {
    const lines = critiques.map((critique) => {
      const delivery = critique.delivered ? 'delivered' : 'withheld';
      return `- [${critique.severity}, ${delivery}] ${critique.text}`;
    });
    sections.push(`Recent critiques:\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
