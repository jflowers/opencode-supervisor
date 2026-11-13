/**
 * Plugin logger (FR-052..FR-055): routes every supervisor diagnostic
 * to the OpenCode server log through the SDK client's `/log`
 * endpoint instead of stdout/stderr. The plugin runs inside the
 * OpenCode server process, so console writes interleave with the
 * TUI; `client.app.log` lands in the server log with a service tag,
 * level, and message. Delivery is fire-and-forget — a server
 * listener that is not yet up during plugin bootstrap rejects the
 * POST and the rejection is absorbed, never blocking a hook and
 * never surfacing as an unhandled rejection (FR-053). Warn and
 * error entries dedupe per logger instance by level and message so
 * per-step failure loops (an audit failing open on every reasoning
 * step) log once instead of spraying (FR-054); info entries are
 * structurally rare (identity, directive triggers, gate grants) and
 * are never deduplicated, so a retried identity line still lands.
 * The module holds only the client reference and performs no direct
 * I/O, preserving the src/ purity convention.
 */

import type { PluginInput } from '@opencode-ai/plugin';

import { PLUGIN_ID } from './plugin-id.ts';

/** Log levels the plugin logger emits, mapping 1:1 to /log levels. */
export type PluginLogLevel = 'info' | 'warn' | 'error';

/** A single recorded delivery, as passed to `client.app.log`. */
export interface PluginLogEntry {
  service: string;
  level: PluginLogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

/** Emitter for one level; never throws, never returns a promise. */
export type PluginLogFn = (message: string, extra?: Record<string, unknown>) => void;

/** The logger surface threaded through hooks and helpers. */
export interface PluginLogger {
  info: PluginLogFn;
  warn: PluginLogFn;
  error: PluginLogFn;
}

/** Service tag every entry carries in the OpenCode server log. */
export const PLUGIN_LOG_SERVICE = PLUGIN_ID;

/**
 * Cap on dedupe keys (review round 1, LOW): once the set holds this
 * many entries it clears, so a long-lived process cannot grow the
 * set without bound and a message first seen before the clear can
 * log again — bounded memory in exchange for a rare repeat.
 */
export const PLUGIN_LOG_DEDUPE_CAP = 512;

/**
 * Shared no-op logger (review round 5): the fallback for optional
 * logger parameters (createInvokeModel's 2-arg callers) and the
 * stand-in tests reach for, so silence is declared once instead of
 * hand-copied at every call site.
 */
export const silentPluginLogger: PluginLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const createPluginLogger = (
  client: PluginInput['client'],
  service: string = PLUGIN_LOG_SERVICE
): PluginLogger => {
  const seen = new Set<string>();
  const write = (
    level: PluginLogLevel,
    message: string,
    extra?: Record<string, unknown>
  ): void => {
    if (message === '') return;
    if (level !== 'info') {
      const key = `${level}:${message}`;
      if (seen.has(key)) return;
      if (seen.size >= PLUGIN_LOG_DEDUPE_CAP) {
        seen.clear();
      }
      seen.add(key);
    }
    try {
      // Review round 5: the request body IS a PluginLogEntry — typing
      // the local keeps the exported interface and the wire shape in
      // lockstep when either changes.
      const entry: PluginLogEntry = { service, level, message, extra };
      client
        .app.log({ body: entry })
        .catch(() => {});
    } catch {
      // A client without a resolvable app surface, or a synchronously
      // throwing log call, is absorbed like a rejected POST (FR-053).
    }
  };
  return {
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
  };
};

export { createPluginLogger };
