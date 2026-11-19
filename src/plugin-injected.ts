/**
 * Plugin-Injected Tool Arguments (FR-106)
 *
 * Other plugins may fill in or change tool arguments in their own
 * `tool.execute.before` hook (opencode-research-harness adds a topic
 * tag, a Dewey `source_id`/`tag`, or a default `path` on grep/glob).
 * OpenCode stores the call's input after every hook ran, so the agent
 * sees the edited arguments as its own call, reasons about them as if
 * it wrote them, and the auditor then flags its own "deviation".
 *
 * Producers publish what they injected per callID on their
 * process-wide shared state; this module reads it (read-only) and
 * renders a bounded section for the auditor prompt naming the
 * arguments the agent did not write. Pure apart from the `globalThis`
 * read; no OpenCode imports, no I/O.
 */

/** One injected-args record as a producer publishes it. */
export interface InjectedArgsRecord {
  sessionID: string;
  tool: string;
  /** Only the injected part (see the producer's contract). */
  args: Record<string, unknown>;
}

/** Shared-state symbols of plugins known to publish `injectedArgs`. */
export const INJECTED_ARGS_PRODUCERS: readonly { plugin: string; key: symbol }[] = [
  { plugin: 'opencode-research-harness', key: Symbol.for('opencode-research-harness.shared-state') },
];

/** Most recent records per session rendered into one audit prompt. */
export const MAX_INJECTED_ARGS_RECORDS = 12;

/** Character bound on one rendered value, so a large injected value cannot crowd the prompt. */
export const MAX_INJECTED_VALUE_CHARS = 200;

/** A record with the plugin that published it. */
export interface AttributedInjectedArgs extends InjectedArgsRecord {
  plugin: string;
  callID: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The session's most recent plugin-injected argument records across
 * every known producer, oldest first, at most `limit`. A missing or
 * malformed producer state reads as "nothing injected" — this is
 * advisory context, so it never throws.
 *
 * @param sessionID The audited session.
 * @param limit Maximum records returned (the most recent win).
 * @param store The object holding the producers' shared state (tests pass their own).
 */
export function injectedArgsForSession(
  sessionID: string,
  limit: number = MAX_INJECTED_ARGS_RECORDS,
  store: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>
): AttributedInjectedArgs[] {
  const found: AttributedInjectedArgs[] = [];
  for (const { plugin, key } of INJECTED_ARGS_PRODUCERS) {
    const state = store[key];
    const map = isRecord(state) ? state.injectedArgs : undefined;
    if (!(map instanceof Map)) continue;
    for (const [callID, record] of map) {
      if (typeof callID !== 'string' || !isRecord(record)) continue;
      if (record.sessionID !== sessionID || typeof record.tool !== 'string' || !isRecord(record.args)) continue;
      found.push({ plugin, callID, sessionID, tool: record.tool, args: record.args });
    }
  }
  return limit > 0 ? found.slice(-limit) : [];
}

const renderValue = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_INJECTED_VALUE_CHARS ? `${text.slice(0, MAX_INJECTED_VALUE_CHARS)}…` : text;
};

/**
 * Renders the records as auditor-prompt lines, one per call, or
 * undefined when there are none (the prompt then stays unchanged).
 * Array values list only the elements the plugin appended.
 */
export function renderInjectedArgs(records: readonly AttributedInjectedArgs[]): string | undefined {
  const lines = records
    .map((record) => {
      const entries = Object.entries(record.args).map(([key, value]) => `${key}=${renderValue(value)}`);
      return entries.length === 0 ? undefined : `- ${record.tool} (call ${record.callID}, by ${record.plugin}): ${entries.join(', ')}`;
    })
    .filter((line): line is string => line !== undefined);
  return lines.length === 0 ? undefined : lines.join('\n');
}
