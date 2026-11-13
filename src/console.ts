/**
 * Agent-Console Tools: Reports and Recall
 * Pure storage and rendering for the agent console's second slice
 * (FR-033..FR-036): the `report` tool's backing data, the memo's
 * `Agent reports:` section, and the `recall` tool's rendering of stored
 * supervision state. Reports are records of events the supervised agent
 * noticed — blockers, deviations, outcomes, notes — kept for the
 * engineer; they are not constraints on future turns (reminders are that)
 * and never enter audit prompts (design D8 trust boundary). This module
 * also owns the retention constants that decouple storage depth from the
 * memo's render caps (design D3), so `recall` can surface entries the
 * memo no longer shows. Pure module: no OpenCode imports, no I/O, no
 * clock — `addedAt` is injected by the hook layer.
 */

import { takeMostRecent, type CritiqueRecord, type SolvedItem } from './records.ts';
import { renderReminders, type Reminder } from './reminders.ts';

/** Fixed ceiling on stored report text (FR-034, design D2), deliberately not configurable. */
export const MAX_REPORT_TEXT = 2000;

/**
 * Storage retention for solved items (design D3): stored depth is
 * deliberately deeper than the memo's render cap so `recall` (FR-033) can
 * surface entries the memo no longer shows. A memory-footprint bound, not
 * a user-facing knob.
 */
export const SOLVED_RETENTION_CAP = 50;

/**
 * Storage retention for the critique log (design D3): same rationale as
 * SOLVED_RETENTION_CAP — recall reaches deeper than the memo renders.
 */
export const CRITIQUE_RETENTION_CAP = 30;

/** The supported report kinds (FR-034, design D2): a fixed vocabulary keeps the memo section scannable. */
export const REPORT_KINDS = ['blocker', 'deviation', 'outcome', 'note'] as const;

/** One report kind (FR-034). */
export type ReportKind = (typeof REPORT_KINDS)[number];

/** One stored report (FR-034, design D2): kind, prepared text, ISO timestamp. No id, not clearable (FR-035). */
export interface AgentReport {
  /** What kind of event this records (FR-034). */
  kind: ReportKind;
  /** Prepared text: trimmed, non-empty, at most MAX_REPORT_TEXT characters. */
  text: string;
  /** ISO timestamp injected by the hook layer. */
  addedAt: string;
}

/** Outcome of preparing raw report text for storage (FR-034). */
export type PreparedReportText =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Prepares report text for storage (FR-034): whitespace-only input is
 * rejected with an actionable message; anything longer than MAX_REPORT_TEXT
 * is truncated and flagged so the tool result can note it. Mirrors the
 * reminder text hygiene (FR-025 pattern, design D2).
 *
 * @param raw The `report` text argument.
 * @returns The prepared text, or the rejection the tool returns verbatim.
 */
export function prepareReportText(raw: string): PreparedReportText {
  const text = raw.trim();
  if (text.length === 0) {
    return {
      ok: false,
      error:
        'Report text is empty after trimming — state the event to report (a blocker, deviation, outcome, or note).',
    };
  }
  if (text.length > MAX_REPORT_TEXT) {
    return { ok: true, text: text.slice(0, MAX_REPORT_TEXT), truncated: true };
  }
  return { ok: true, text, truncated: false };
}

/**
 * Fixed ceiling on the `request_audit` focus (FR-078): the same bound
 * as report text, so every agent-authored console input is capped.
 * Deliberately not configurable.
 */
export const MAX_AUDIT_FOCUS = MAX_REPORT_TEXT;

/** Outcome of preparing a raw `request_audit` focus (FR-078). */
export type PreparedAuditFocus =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Prepares a `request_audit` focus before narrative stripping
 * (FR-037, FR-078): whitespace-only input is rejected with the
 * actionable message the tool returns; anything longer than
 * MAX_AUDIT_FOCUS is truncated and flagged, so the stripper, the
 * auditor prompt, the verified trace, and the result all see bounded
 * text.
 *
 * @param raw The `request_audit` focus argument.
 * @returns The prepared focus, or the rejection the tool returns verbatim.
 */
export function prepareAuditFocus(raw: string): PreparedAuditFocus {
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, error: 'Audit focus is empty after trimming — state the claim or step to check.' };
  }
  if (text.length > MAX_AUDIT_FOCUS) {
    return { ok: true, text: text.slice(0, MAX_AUDIT_FOCUS), truncated: true };
  }
  return { ok: true, text, truncated: false };
}

/**
 * Appends a report, keeping at most the `cap` most recent entries
 * (FR-035). Pure: returns the next array rather than mutating, so the
 * hook layer assigns the result back to session state. A cap of zero or
 * less stores nothing.
 *
 * @param reports The session's current reports.
 * @param report The prepared report to append.
 * @param cap The maximum number of reports to store.
 * @returns The next bounded reports array.
 */
export function addReport(reports: AgentReport[], report: AgentReport, cap: number): AgentReport[] {
  return takeMostRecent([...reports, report], cap);
}

/**
 * Renders the memo's `Agent reports:` section (FR-036): each entry shows
 * its kind and text, bounded to the `cap` most recent reports. Null when
 * there is nothing to show, so the section appears only when it has
 * content — the memo omits it entirely for sessions without reports.
 *
 * @param reports The session's current reports.
 * @param cap The maximum number of reports to render.
 * @returns The section text, or null when empty (or the cap is zero or less).
 */
export function renderReports(reports: AgentReport[], cap: number): string | null {
  const shown = takeMostRecent(reports, cap);
  if (shown.length === 0) {
    return null;
  }
  const lines = shown.map((report) => `- [${report.kind}] ${report.text}`);
  return `Agent reports:\n${lines.join('\n')}`;
}

/** The stored supervision state `recall` renders (FR-033): plain data, no session identity. */
export interface RecallInput {
  /** Session goal — the first user message (FR-013); absent until captured. */
  goal?: string;
  /** Agent-set reminders (FR-020), stored bounded to the most recent. */
  reminders: Reminder[];
  /** Retained solved items (FR-014, design D3 retention). */
  solvedItems: SolvedItem[];
  /** Delivered and withheld critiques (FR-015, design D3 retention). */
  critiques: CritiqueRecord[];
}

/**
 * Renders the requested stored state for `recall` (FR-033, design D4):
 * `goal`, `reminders`, `solved`, `critiques`, or `all` (the default the
 * tool passes when `what` is absent). Each section returns the FULL
 * stored list — storage retention is deeper than the memo's render caps
 * (design D3), so entries the memo no longer shows remain reachable. An
 * empty section states that plainly; an unsupported `what` returns an
 * actionable listing of the supported values (the forget_reminder
 * unknown-id pattern). Output is bounded by construction: every list is
 * retention-capped and reminder text is at most 2000 characters.
 *
 * @param what The requested section (already defaulted by the caller).
 * @param input The session's stored supervision state.
 * @returns The rendered section text.
 */
export function renderRecall(what: string, input: RecallInput): string {
  const renderGoal = (): string => {
    const goal = input.goal?.trim();
    return goal !== undefined && goal !== '' ? `Session goal:\n${goal}` : 'No goal is stored for this session.';
  };
  const renderReminderSection = (): string => {
    const rendered = renderReminders(input.reminders, input.reminders.length);
    return rendered ?? 'No reminders are stored for this session.';
  };
  const renderSolved = (): string => {
    if (input.solvedItems.length === 0) {
      return 'No solved items are stored for this session.';
    }
    const lines = input.solvedItems.map((item) => `- ${item.tool}: ${item.outcome}`);
    return `Solved items:\n${lines.join('\n')}`;
  };
  const renderCritiques = (): string => {
    if (input.critiques.length === 0) {
      return 'No critiques are stored for this session.';
    }
    const lines = input.critiques.map((critique) => {
      const delivery = critique.delivered ? 'delivered' : 'withheld';
      return `- [${critique.severity}, ${delivery}] ${critique.text}`;
    });
    return `Critiques:\n${lines.join('\n')}`;
  };
  switch (what) {
    case 'goal':
      return renderGoal();
    case 'reminders':
      return renderReminderSection();
    case 'solved':
      return renderSolved();
    case 'critiques':
      return renderCritiques();
    case 'all':
      return [renderGoal(), renderReminderSection(), renderSolved(), renderCritiques()].join('\n\n');
    default:
      return `Unknown section "${what}" — supported values: goal, reminders, solved, critiques, all.`;
  }
}
