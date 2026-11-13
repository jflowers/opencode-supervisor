/**
 * Shared Supervision Records
 * Leaf module for the record shapes and bounding helper that the memo
 * builder (`memo.ts`), the agent console (`console.ts`), and the
 * reminder store (`reminders.ts`) all use. Holding them here breaks the
 * former `memo.ts` ↔ `console.ts` import cycle (convention AP-006): this
 * module imports nothing from its consumers — only the `AuditSeverity`
 * type from the auditor. Pure: no OpenCode imports, no I/O.
 */

import type { AuditSeverity } from './auditor.ts';

/** One completed tool call in the solved-items log (FR-014). */
export interface SolvedItem {
  /** Tool name from the completed call (FR-014). */
  tool: string;
  /** Short outcome summary recorded when the call completed (FR-014). */
  outcome: string;
}

/** One critique in the critique log, delivered or withheld (FR-015). */
export interface CritiqueRecord {
  text: string;
  severity: AuditSeverity;
  /** Whether the critique was delivered to the session or withheld (FR-015 records both). */
  delivered: boolean;
}

/**
 * Bounds a list to its most recent entries (FR-017, FR-023, FR-035):
 * the end of the array is the most recent entry, so bounding keeps the
 * tail. A cap of zero or less yields no entries — `slice(-0)` would
 * return the whole array, since -0 === 0. Returns a new array when it
 * trims and never mutates its input.
 *
 * @param items The list, oldest first.
 * @param cap The maximum number of entries to keep.
 * @returns At most `cap` of the most recent entries.
 */
export function takeMostRecent<T>(items: readonly T[], cap: number): T[] {
  if (cap <= 0) {
    return [];
  }
  return items.length > cap ? items.slice(items.length - cap) : [...items];
}
