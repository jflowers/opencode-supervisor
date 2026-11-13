/**
 * Agent-Console Reminders
 * Pure storage for the agent console's reminder surface (FR-020..FR-025):
 * the `remind_me` / `forget_reminder` tools' backing data and the memo's
 * `Reminders:` section. Reminders are facts the primary agent wants kept
 * in view across turns — dead ends, environment quirks, decisions, user
 * constraints — and they re-enter the conversation through the memo each
 * turn (FR-022), so they survive context compaction. Ids are `r<n>` from
 * a per-session sequence owned by the hook layer (design D2/D3): this
 * module takes id and timestamp as parameters and never touches the
 * clock, randomness, or I/O. Storage (FR-023) and rendering are both
 * bounded to the most recent entries within the configured cap, and
 * reminder text is trimmed and truncated at a fixed ceiling (FR-025,
 * design D5) so an agent cannot grow the memo without limit.
 */

import { takeMostRecent } from './records.ts';

/** One stored reminder (FR-020): id, text, and ISO timestamp of registration. */
export interface Reminder {
  /** Stable id (`r<n>`, per-session sequence, never recycled — design D3). */
  id: string;
  /** Prepared text: trimmed, non-empty, at most MAX_REMINDER_TEXT_LENGTH chars. */
  text: string;
  /** ISO timestamp injected by the hook layer (design D2). */
  addedAt: string;
}

/** Fixed ceiling on stored reminder text (FR-025, design D5): a hygiene bound, deliberately not configurable. */
export const MAX_REMINDER_TEXT_LENGTH = 2000;

/** Outcome of preparing raw tool input for storage (FR-025). */
export type PreparedReminderText =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Prepares reminder text for storage (FR-025): whitespace-only input is
 * rejected with an actionable message; anything longer than
 * MAX_REMINDER_TEXT_LENGTH is truncated and flagged so the tool result
 * can note it.
 *
 * @param raw The `remind_me` text argument.
 * @returns The prepared text, or the rejection the tool returns verbatim.
 */
export function prepareReminderText(raw: string): PreparedReminderText {
  const text = raw.trim();
  if (text.length === 0) {
    return {
      ok: false,
      error:
        'Reminder text is empty after trimming — state the fact to remember (a dead end, environment quirk, decision, or user constraint).',
    };
  }
  if (text.length > MAX_REMINDER_TEXT_LENGTH) {
    return { ok: true, text: text.slice(0, MAX_REMINDER_TEXT_LENGTH), truncated: true };
  }
  return { ok: true, text, truncated: false };
}

/**
 * Appends a reminder, keeping at most the `cap` most recent entries
 * (FR-023). Pure: returns the next array rather than mutating, so the
 * hook layer assigns the result back to session state. A cap of zero or
 * less stores nothing.
 *
 * @param reminders The session's current reminders.
 * @param reminder The prepared reminder to append.
 * @param cap The maximum number of reminders to store.
 * @returns The next bounded reminders array.
 */
export function addReminder(reminders: Reminder[], reminder: Reminder, cap: number): Reminder[] {
  return takeMostRecent([...reminders, reminder], cap);
}

/**
 * Removes the reminder with the given id (FR-021). Forgetting never
 * renumbers and never recycles ids (design D3).
 *
 * @param reminders The session's current reminders.
 * @param id The reminder id to clear.
 * @returns The next reminders array, or null when no reminder matches.
 */
export function clearReminder(reminders: Reminder[], id: string): Reminder[] | null {
  const index = reminders.findIndex((reminder) => reminder.id === id);
  if (index === -1) {
    return null;
  }
  return [...reminders.slice(0, index), ...reminders.slice(index + 1)];
}

/**
 * Renders the memo's `Reminders:` section (FR-022): `- <id>: <text>`
 * entries in registration order (most recent last), bounded to the `cap`
 * most recent reminders. Ids render so `forget_reminder` works from the
 * memo alone. Null when there is nothing to show, so the section appears
 * only when it has content — the memo omits it entirely for sessions
 * without reminders.
 *
 * @param reminders The session's current reminders.
 * @param cap The maximum number of reminders to render.
 * @returns The section text, or null when empty (or the cap is zero or less).
 */
export function renderReminders(reminders: Reminder[], cap: number): string | null {
  const shown = takeMostRecent(reminders, cap);
  if (shown.length === 0) {
    return null;
  }
  const lines = shown.map((reminder) => `- ${reminder.id}: ${reminder.text}`);
  return `Reminders:\n${lines.join('\n')}`;
}
