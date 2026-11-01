/**
 * opencode-supervisor — OpenCode Process Supervision hook layer
 *
 * Thin `@opencode-ai/plugin` module (design D1): `server(input,
 * options)` returns hooks that observe completed reasoning parts
 * (`event`), capture the session goal (`chat.message`), guard tool
 * execution (`tool.execute.before` / `tool.execute.after`), offer
 * the agent self-serve reminder tools (`tool`, FR-020/FR-021),
 * the agent console's second slice — recall, report, and
 * on-demand audit tools (`tool`, FR-033..FR-041),
 * load and enforce engineer directives (FR-026..FR-032), and inject
 * the supervision memo (`experimental.chat.messages.transform`; FR-016
 * moved off `experimental.chat.system.transform` — OpenCode 1.19.0
 * discards system-transform payload mutations, so the memo rides a
 * transform-time user message instead). All
 * audit logic lives in the pure `src/` modules; this file owns the
 * per-session state (design D4), config resolution (session plugin
 * config → environment → `pluginConfig` defaults), the D2
 * `invokeModel` adapter that drives a dedicated auditor side session
 * through `input.client.session.prompt` — never the supervised
 * conversation (FR-004) — and the fail-open directive loader
 * (FR-032). Supervision fails open (FR-005): no hook path may
 * crash or stall the supervised session, except the tool guard's
 * deliberate block throw (spike 1.3).
 *
 * Runtime: Bun / TypeScript. Entry: default-exported PluginModule
 * (spike 1.4 — file-source plugins must carry `id`).
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { tool, type Hooks, type PluginInput, type PluginModule, type PluginOptions } from '@opencode-ai/plugin';
import {
  DEFAULT_ARG_REPAIR,
  isPlainObject,
  mergeArgsInPlace,
  repairToolArgs,
  SUPERVISOR_MODES,
  type ArgRepairConfig,
  type RepairInvoker,
  type SupervisorMode,
} from './src/arg-repair.ts';
import {
  outcomeRecordsStep,
  resolveAuditorConfig,
  runPeerAudit,
  type AuditConfig,
  type AuditSeverity,
  type InvokeModel,
  type VerifiedTraceEntry,
} from './src/auditor.ts';
import { stripNarrative } from './src/stripper.ts';
import { extractPathTokens } from './src/path-tokens.ts';
import { checkProtectedState, isTokenCovered, verifyToolIntent, type ToolVerificationResult } from './src/tool-guard.ts';
import {
  buildMemo,
  DEFAULT_MEMO_LIMITS,
  type CritiqueRecord,
  type MemoLimits,
  type SolvedItem
} from './src/memo.ts';
import {
  addReport,
  CRITIQUE_RETENTION_CAP,
  prepareReportText,
  renderRecall,
  REPORT_KINDS,
  SOLVED_RETENTION_CAP,
  type AgentReport,
  type ReportKind
} from './src/console.ts';
import {
  addReminder,
  clearReminder,
  prepareReminderText,
  type Reminder,
} from './src/reminders.ts';
import {
  activeDirectives,
  compileEnforcement,
  compileRepairTools,
  extractPolicyPaths,
  matchRepairTools,
  matchTriggers,
  MAX_DIRECTIVES,
  parseDirectives,
  parseOptionsDirectives,
  renderDirectivesAdvisory,
  type Directive,
} from './src/directives.ts';
import {
  compileGates,
  evaluateApproveGate,
  evaluateReviewGates,
  matchApproveGates,
  MAX_APPROVALS_FILE_BYTES,
  parseApprovals,
  type ApprovalRecord,
} from './src/gates.ts';
import {
  MAX_CONFIG_FILE_BYTES,
  parseSupervisorConfigFile,
  validateSupervisorConfig,
  type ParsedSupervisorConfig,
  type SupervisorFileConfig,
} from './src/config-file.ts';
import { createPluginLogger, silentPluginLogger, type PluginLogger } from './src/plugin-log.ts';

// ── Configuration (session plugin config → environment → defaults) ──

/** Environment names for the hook-layer knobs, following the OPENCODE_SUPERVISOR_* convention. */
const ENV_MAX_REGENERATIONS = 'OPENCODE_SUPERVISOR_MAX_REGENERATIONS';
const ENV_STRIP_MODE = 'OPENCODE_SUPERVISOR_STRIP_MODE';
const ENV_BLOCK_REWARD_HACKING = 'OPENCODE_SUPERVISOR_BLOCK_REWARD_HACKING';
const ENV_REQUIRE_STEP_REFERENCE = 'OPENCODE_SUPERVISOR_REQUIRE_STEP_REFERENCE_IN_TOOLS';
const ENV_MEMO_MAX_SOLVED_ITEMS = 'OPENCODE_SUPERVISOR_MEMO_MAX_SOLVED_ITEMS';
const ENV_MEMO_MAX_CRITIQUES = 'OPENCODE_SUPERVISOR_MEMO_MAX_CRITIQUES';
const ENV_MEMO_MAX_REMINDERS = 'OPENCODE_SUPERVISOR_MEMO_MAX_REMINDERS';
const ENV_MEMO_MAX_REPORTS = 'OPENCODE_SUPERVISOR_MEMO_MAX_REPORTS';
const ENV_MAX_ON_DEMAND_AUDITS = 'OPENCODE_SUPERVISOR_MAX_ON_DEMAND_AUDITS';
const ENV_MAX_TIMEOUT_FAIL_OPENS = 'OPENCODE_SUPERVISOR_MAX_TIMEOUT_FAIL_OPENS';
const ENV_MAX_COVERED_TIMEOUT_FAIL_OPENS = 'OPENCODE_SUPERVISOR_MAX_COVERED_TIMEOUT_FAIL_OPENS';
const ENV_MODE = 'OPENCODE_SUPERVISOR_MODE';
const ENV_REPAIR_MODEL = 'OPENCODE_SUPERVISOR_REPAIR_MODEL';

/**
 * Hook-layer configuration: the auditor's `AuditConfig` plus the memo
 * bounds (FR-017). Resolved per use by `resolveHookConfig` with the
 * precedence session plugin config → environment → project file →
 * plugin options → global file → derived model (auditorModel only) →
 * `pluginConfig` defaults (FR-056).
 */
export interface HookConfig extends AuditConfig {
  /** Caps on memo solved items, critiques, reminders, and reports (FR-017, FR-023, FR-035/FR-036). */
  memoLimits: MemoLimits;
  /** Per-session cap on on-demand audits requested through the request_audit tool (FR-039). */
  maxOnDemandAudits: number;
  /** Per-session cap on trace-check timeout fail-opens (FR-067, design D8): past it, a timed-out wait blocks. */
  maxTimeoutFailOpens: number;
  /** Per-session cap on covered timeout fail-opens (FR-070, design D4): waits whose blocked token an in-flight audit names. */
  maxCoveredTimeoutFailOpens: number;
  /** Supervisor mode: 'full' (everything) or 'repair-only' (tool-arg repair only). */
  mode: SupervisorMode;
  /** Tool-argument repair configuration (deterministic first, model tier second). */
  argRepair: ArgRepairConfig;
}

/**
 * Plugin defaults — the lowest precedence tier. No auditor model or
 * variant default exists (FR-059): the auditor resolves from the
 * environment, the config files, the tuple options, or the derived
 * OpenCode model (FR-056), and with none set the LLM audit tier is
 * skipped entirely (FR-060). The v0 HTTP-endpoint auditor fallback
 * is gone: audits run only through the side session (D2).
 */
export const pluginConfig: HookConfig = {
  stripMode: 'code_and_math',
  maxRegenerations: 2,
  blockRewardHacking: true,
  requireStepReferenceInTools: true,
  memoLimits: { ...DEFAULT_MEMO_LIMITS },
  maxOnDemandAudits: 8,
  maxTimeoutFailOpens: 3,
  maxCoveredTimeoutFailOpens: 6,
  mode: 'full',
  argRepair: { ...DEFAULT_ARG_REPAIR, tools: [...DEFAULT_ARG_REPAIR.tools] },
};

/**
 * Plugin version for the module-identity log line (review finding #20) —
 * kept in sync with `package.json` so runtime logs identify the loaded
 * build. `package.json` cannot be imported from here without a build
 * step, so the constant is the source of truth for the log prefix.
 */
export const PLUGIN_VERSION = '2.8.0';

/**
 * Log-identity state (FR-055): the module-identity line is emitted
 * once per process, at the first hook-time config resolution. Held
 * in an exported object so tests can reset the once-flags between
 * harnesses (each test server re-registers the plugin).
 */
export const logIdentityState = {
  /** True once the identity line has been emitted. */
  identityLogged: false,
  /** True once the identity line has said the auditor is absent; a later-resolving model announces itself (review round 1). */
  identitySaidNoModel: false,
};

/**
 * Trace-await state (FR-067, design D8): the bounded wait's timeout,
 * in milliseconds. Held in exported mutable state — the
 * `logIdentityState` precedent — so the timeout tests run in
 * milliseconds, not ten seconds. The bound is 10 seconds because a
 * small-model side-session round trip is seconds; the derived-lookup
 * precedent budgets 5 s for a cheap GET, and an LLM call needs more.
 */
export const traceAwaitState = { timeoutMs: 10_000 };

/** Session shape carrying plugin config overrides — the same key `resolveAuditorConfig` reads, so one override object governs the whole plugin. */
const PLUGIN_CONFIG_KEY = 'opencode-supervisor';

interface SessionWithPluginConfig {
  config?: { plugins?: Record<string, unknown> };
}

function sessionOverrides(session?: SessionWithPluginConfig): Record<string, unknown> {
  const overrides = session?.config?.plugins?.[PLUGIN_CONFIG_KEY];
  return typeof overrides === 'object' && overrides !== null ? (overrides as Record<string, unknown>) : {};
}

function memoLimitOverrides(value: unknown): Partial<MemoLimits> {
  return typeof value === 'object' && value !== null ? (value as Partial<MemoLimits>) : {};
}

function envText(name: string): string | undefined {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return raw === undefined || raw === '' ? undefined : raw;
}

/** Non-negative finite numbers only; anything else falls through (fail-open). */
function envNumber(name: string): number | undefined {
  const parsed = Number(envText(name));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function envBoolean(name: string): boolean | undefined {
  const raw = envText(name);
  return raw === 'true' ? true : raw === 'false' ? false : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pickStripMode(value: unknown): HookConfig['stripMode'] | undefined {
  return value === 'code_and_math' || value === 'balanced' || value === 'strict' ? value : undefined;
}

function pickSupervisorMode(value: unknown): SupervisorMode | undefined {
  return value === 'full' || value === 'repair-only' ? value : undefined;
}

/** Model slugs are `provider/model` strings; blank strings are treated as unset. */
function pickModelSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function argRepairOverrides(value: unknown): Partial<ArgRepairConfig> {
  return typeof value === 'object' && value !== null ? (value as Partial<ArgRepairConfig>) : {};
}

/**
 * File/options config tiers for `resolveHookConfig` (FR-056). Each tier
 * is a validated `SupervisorFileConfig` subset; `derivedModel` carries
 * the OpenCode-config-derived model (FR-058) and applies to
 * `auditorModel` only.
 */
export interface SupervisorConfigSources {
  /** Project-level config file (highest file tier). */
  project?: SupervisorFileConfig;
  /** Global user-level config file (lowest file tier). */
  global?: SupervisorFileConfig;
  /** Tuple-registration plugin options config. */
  options?: SupervisorFileConfig;
  /** Model derived from the OpenCode client config (auditorModel only). */
  derivedModel?: string;
}

/** First defined value, or undefined — `??` chains for heterogeneous tiers. */
const tiered = <T>(...values: (T | undefined)[]): T | undefined =>
  values.find((value) => value !== undefined);

/**
 * Resolves the effective hook-layer configuration with precedence
 * session plugin config → environment → project file → plugin options
 * → global file → derived model (auditorModel only) → `pluginConfig`
 * defaults (FR-056). `resolveAuditorConfig` owns the session/env/model
 * base tiers; the file and options tiers are validated subsets supplied
 * by the caller. `??` rather than `||` throughout: `false` and `0` are
 * meaningful settings and must not fall through to the defaults.
 *
 * Runtime reachability note (review finding #6, verified against
 * `@opencode-ai/plugin` 1.19.4): every hook receives only a
 * `sessionID` — no hook payload carries a session object with plugin
 * config (the `chat.params` input exposes sessionID, agent, model,
 * provider, and message, but no plugin config), so the session tier is
 * unreachable from the hook paths and exists for direct callers and
 * unit tests. The documented runtime chain is environment → files →
 * options → derived → defaults.
 *
 * @param session Optional session object carrying plugin config overrides.
 * @param sources File/options config tiers (validated by `src/config-file.ts`).
 * @returns The resolved hook-layer configuration.
 */
export function resolveHookConfig(
  session?: SessionWithPluginConfig,
  sources: SupervisorConfigSources = {}
): HookConfig {
  const overrides = sessionOverrides(session);
  const memoOverrides = memoLimitOverrides(overrides.memoLimits);
  const repairOverrides = argRepairOverrides(overrides.argRepair);
  const base = resolveAuditorConfig(pluginConfig, session);
  const auditorModel = tiered(
    base.auditorModel,
    sources.project?.auditorModel,
    sources.options?.auditorModel,
    sources.global?.auditorModel,
    sources.derivedModel
  );
  return {
    ...base,
    auditorModel,
    auditorVariant: tiered(
      base.auditorVariant,
      sources.project?.auditorVariant,
      sources.options?.auditorVariant,
      sources.global?.auditorVariant
    ),
    maxRegenerations:
      pickNumber(overrides.maxRegenerations) ??
      envNumber(ENV_MAX_REGENERATIONS) ??
      tiered(sources.project?.maxRegenerations, sources.options?.maxRegenerations, sources.global?.maxRegenerations) ??
      base.maxRegenerations,
    stripMode:
      pickStripMode(overrides.stripMode) ??
      pickStripMode(envText(ENV_STRIP_MODE)) ??
      tiered(sources.project?.stripMode, sources.options?.stripMode, sources.global?.stripMode) ??
      base.stripMode,
    blockRewardHacking:
      pickBoolean(overrides.blockRewardHacking) ??
      envBoolean(ENV_BLOCK_REWARD_HACKING) ??
      tiered(sources.project?.blockRewardHacking, sources.options?.blockRewardHacking, sources.global?.blockRewardHacking) ??
      base.blockRewardHacking,
    requireStepReferenceInTools:
      pickBoolean(overrides.requireStepReferenceInTools) ??
      envBoolean(ENV_REQUIRE_STEP_REFERENCE) ??
      tiered(
        sources.project?.requireStepReferenceInTools,
        sources.options?.requireStepReferenceInTools,
        sources.global?.requireStepReferenceInTools
      ) ??
      base.requireStepReferenceInTools,
    memoLimits: {
      maxSolvedItems:
        pickNumber(memoOverrides.maxSolvedItems) ??
        envNumber(ENV_MEMO_MAX_SOLVED_ITEMS) ??
        tiered(sources.project?.memoLimits?.maxSolvedItems, sources.options?.memoLimits?.maxSolvedItems, sources.global?.memoLimits?.maxSolvedItems) ??
        pluginConfig.memoLimits.maxSolvedItems,
      maxCritiques:
        pickNumber(memoOverrides.maxCritiques) ??
        envNumber(ENV_MEMO_MAX_CRITIQUES) ??
        tiered(sources.project?.memoLimits?.maxCritiques, sources.options?.memoLimits?.maxCritiques, sources.global?.memoLimits?.maxCritiques) ??
        pluginConfig.memoLimits.maxCritiques,
      maxReminders:
        pickNumber(memoOverrides.maxReminders) ??
        envNumber(ENV_MEMO_MAX_REMINDERS) ??
        tiered(sources.project?.memoLimits?.maxReminders, sources.options?.memoLimits?.maxReminders, sources.global?.memoLimits?.maxReminders) ??
        pluginConfig.memoLimits.maxReminders,
      maxReports:
        pickNumber(memoOverrides.maxReports) ??
        envNumber(ENV_MEMO_MAX_REPORTS) ??
        tiered(sources.project?.memoLimits?.maxReports, sources.options?.memoLimits?.maxReports, sources.global?.memoLimits?.maxReports) ??
        pluginConfig.memoLimits.maxReports,
    },
    maxOnDemandAudits:
      pickNumber(overrides.maxOnDemandAudits) ??
      envNumber(ENV_MAX_ON_DEMAND_AUDITS) ??
      tiered(sources.project?.maxOnDemandAudits, sources.options?.maxOnDemandAudits, sources.global?.maxOnDemandAudits) ??
      pluginConfig.maxOnDemandAudits,
    maxTimeoutFailOpens:
      pickNumber(overrides.maxTimeoutFailOpens) ??
      envNumber(ENV_MAX_TIMEOUT_FAIL_OPENS) ??
      tiered(sources.project?.maxTimeoutFailOpens, sources.options?.maxTimeoutFailOpens, sources.global?.maxTimeoutFailOpens) ??
      pluginConfig.maxTimeoutFailOpens,
    maxCoveredTimeoutFailOpens:
      pickNumber(overrides.maxCoveredTimeoutFailOpens) ??
      envNumber(ENV_MAX_COVERED_TIMEOUT_FAIL_OPENS) ??
      tiered(sources.project?.maxCoveredTimeoutFailOpens, sources.options?.maxCoveredTimeoutFailOpens, sources.global?.maxCoveredTimeoutFailOpens) ??
      pluginConfig.maxCoveredTimeoutFailOpens,
    mode:
      pickSupervisorMode(overrides.mode) ??
      pickSupervisorMode(envText(ENV_MODE)) ??
      tiered(sources.project?.mode, sources.options?.mode, sources.global?.mode) ??
      pluginConfig.mode,
    argRepair: {
      enabled:
        pickBoolean(repairOverrides.enabled) ??
        tiered(sources.project?.argRepair?.enabled, sources.options?.argRepair?.enabled, sources.global?.argRepair?.enabled) ??
        pluginConfig.argRepair.enabled,
      model:
        pickModelSlug(repairOverrides.model) ??
        envText(ENV_REPAIR_MODEL) ??
        tiered(sources.project?.argRepair?.model, sources.options?.argRepair?.model, sources.global?.argRepair?.model) ??
        auditorModel,
      tools:
        tiered(sources.project?.argRepair?.tools, sources.options?.argRepair?.tools, sources.global?.argRepair?.tools) ??
        pluginConfig.argRepair.tools,
      maxPerSession:
        pickNumber(repairOverrides.maxPerSession) ??
        tiered(sources.project?.argRepair?.maxPerSession, sources.options?.argRepair?.maxPerSession, sources.global?.argRepair?.maxPerSession) ??
        pluginConfig.argRepair.maxPerSession,
      timeoutMs:
        pickNumber(repairOverrides.timeoutMs) ??
        tiered(sources.project?.argRepair?.timeoutMs, sources.options?.argRepair?.timeoutMs, sources.global?.argRepair?.timeoutMs) ??
        pluginConfig.argRepair.timeoutMs,
    },
  };
}

// ── Session state (design D4) ──────────────────────────────────────

/** One session's supervision state (design D4): plugin-owned, in-process only. */
export interface SessionState {
  /** Session goal — the first user message (FR-013; captured by `chat.message`). */
  goal: string | undefined;
  /**
   * Verified trace (FR-006, FR-063): recorded step text plus its audit
   * outcome. Passed steps join (recorded in 3.2); a step that failed a
   * minor deterministic invariant stays too, marked `passed: false` —
   * the trace is a path ledger (FR-010), and a misstated tally does not
   * revoke the part's file reasoning.
   */
  verifiedSteps: VerifiedTraceEntry[];
  /** Steer critiques delivered this session, bounded by maxRegenerations (FR-007). */
  critiqueCount: number;
  /** Bounded solved-items log (FR-014; appended by `tool.execute.after`). */
  solvedItems: SolvedItem[];
  /** Delivered and withheld critiques (FR-015). */
  critiqueLog: CritiqueRecord[];
  /** Agent-set reminders (FR-020), stored bounded to the most recent (FR-023). */
  reminders: Reminder[];
  /** Monotonic reminder-id sequence (design D3): ids are `r<n>` and never recycled. */
  reminderSeq: number;
  /** Agent self-reported events (FR-034), bounded to the most recent (FR-035). */
  agentReports: AgentReport[];
  /** On-demand audits run this session (FR-039); bound is `maxOnDemandAudits`. */
  onDemandAuditCount: number;
  /** Directive ids whose `when` rules matched a tool call (FR-029), deduped for the session. */
  triggeredDirectives: string[];
  /** Gate keys approved this session (FR-046), deduped so each grant logs once. */
  grantedGates: Set<string>;
  /**
   * Reasoning-part identities already observed, keyed
   * `sessionID:messageID:partID` (spike 1.1), so duplicate audits are
   * structurally impossible (FR-001).
   */
  seenParts: Set<string>;
  /**
   * In-flight audit continuations (FR-067, design D8): promises the
   * event hook registers after dedupe, resolving only after the trace
   * mutation (or the eviction/critique decision), so a waiting tool
   * call always re-reads a settled trace. Deregistered in a finally.
   * Each entry carries the stripped step's path tokens (FR-070,
   * design D3), so the guard can see whether a blocked token is
   * provably named by reasoning still under audit.
   */
  pendingAudits: Map<Promise<unknown>, string[]>;
  /**
   * Trace-check waits that timed out and failed open this session
   * (FR-067, design D8); the cap is `maxTimeoutFailOpens`. Past the
   * cap a timed-out wait blocks naming the still-unsettled audit.
   */
  timeoutFailOpens: number;
  /**
   * Covered trace-check waits that timed out and failed open this
   * session (FR-070, design D4) — the blocked token was named by an
   * in-flight audit's step text; the cap is
   * `maxCoveredTimeoutFailOpens`. Past the cap a timed-out covered
   * wait blocks naming the still-unsettled audit.
   */
  coveredTimeoutFailOpens: number;
  /**
   * Provider/model identity captured from `chat.message` hook payloads
   * (tool-arg repair): drives the per-model tool-schema lookup so repair
   * validates against the schema the live model actually sees.
   */
  modelIdentity: { providerID: string; modelID: string } | undefined;
  /** Repair-model invocations used this session; bounded by `argRepair.maxPerSession`. */
  repairAttempts: number;
  /** Log-once keys for repair notices, so repeated skips do not spam the plugin log. */
  repairNotices: Set<string>;
}

/** Module-level state (design D4), keyed by session ID. */
const sessions = new Map<string, SessionState>();

function emptySessionState(): SessionState {
  return {
    goal: undefined,
    verifiedSteps: [],
    critiqueCount: 0,
    solvedItems: [],
    critiqueLog: [],
    reminders: [],
    reminderSeq: 0,
    agentReports: [],
    onDemandAuditCount: 0,
    triggeredDirectives: [],
    grantedGates: new Set(),
    seenParts: new Set(),
    pendingAudits: new Map(),
    timeoutFailOpens: 0,
    coveredTimeoutFailOpens: 0,
    modelIdentity: undefined,
    repairAttempts: 0,
    repairNotices: new Set(),
  };
}

/**
 * Session-state accessor (design D4). `get` initializes the session's
 * entry on first access (get/init) and returns the live object — array
 * and Set mutations write through. `peek` reads without initializing,
 * for read-only consumers (the memo transform) that must not create
 * state as a lookup side effect. `cleanup` drops one session's state;
 * `clearAll` backs `dispose`. No persistence: state dies with the
 * opencode process, matching v0 behavior.
 */
export const sessionState = {
  /**
   * Gets (initializing on first access) the live supervision state.
   * @param sessionId The supervised session's ID.
   * @returns The session's state; mutations write through to the Map.
   */
  get(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created = emptySessionState();
    sessions.set(sessionId, created);
    return created;
  },
  /**
   * Peeks at the session's supervision state without initializing it.
   * @param sessionId The supervised session's ID.
   * @returns The session's live state, or undefined when none exists.
   */
  peek(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  },
  /**
   * Drops one session's supervision state.
   * @param sessionId The supervised session's ID.
   */
  cleanup(sessionId: string): void {
    sessions.delete(sessionId);
  },
  /** Drops every session's state (dispose). */
  clearAll(): void {
    sessions.clear();
  },
};

/**
 * Live auditor side-session IDs — self-suppression for the plugin's
 * own machinery (review iteration 2, HIGH finding). The plugin host
 * dispatches every bus event in the plugin's directory to these
 * hooks, and `createInvokeModel` creates its side sessions with the
 * SAME `query: { directory }` — so without suppression the auditor
 * model's own reasoning parts re-enter the `event` hook (recursively
 * spawning further side sessions with a reasoning-emitting auditor),
 * `chat.message` can capture the audit prompt as a side-session
 * goal, and the memo transform can inject the supervision memo
 * into the audit calls. Every hook short-circuits when the incoming
 * session ID is in this set: the pipeline supervises the target
 * conversation, not the plugin's own machinery (FR-001/D2 intent).
 * `createInvokeModel` adds an ID the moment `create` resolves —
 * before prompting — and discards it when the side session is
 * cleaned up, so the set tracks exactly the live side sessions.
 */
const auditorSessionIds = new Set<string>();

/**
 * Monotonic sequence for memo message ids (FR-016): the messages-
 * transform handler appends a fresh memo message per turn; the ids
 * only need to be unique within a dispatch payload, never persisted.
 */
let memoMessageSeq = 0;

/**
 * Whether `sessionId` names one of the plugin's own live auditor
 * side sessions (see `auditorSessionIds`) — the self-suppression
 * check every hook runs before any other logic.
 *
 * @param sessionId The incoming hook's session ID, when present.
 * @returns True when the session is the plugin's own machinery.
 */
function isAuditorSessionId(sessionId: string | undefined): boolean {
  return sessionId !== undefined && auditorSessionIds.has(sessionId);
}

// ── Memo inputs (task 3.4): goal text, solved outcomes, bounds ────

/** Maximum length of a stored solved-item outcome (FR-014 "short outcome"), ellipsis included. */
const SOLVED_OUTCOME_MAX_LENGTH = 80;

/**
 * Prefix of the raw tool output `solvedOutcome` inspects (review
 * iteration 2, LOW): slicing BEFORE collapsing keeps the per-call
 * work constant regardless of output size — tool outputs can be
 * enormous, and regex-collapsing them whole made the cost
 * proportional to that size. The prefix is 2.5x the rendered
 * bound, so outcomes for outputs under it are byte-identical to
 * the unbounded form; beyond it, content past the prefix cannot
 * influence an 80-character summary.
 */
const SOLVED_OUTCOME_PREFIX_LENGTH = 200;

/**
 * Extracts a chat message's user-authored text (FR-013): the joined,
 * trimmed text of its non-synthetic text parts. Synthetic parts — this
 * plugin's own critiques, host auto-continues, other plugins'
 * injections — are not user input and must never become the goal;
 * non-text parts carry no user prose. Structurally defensive (FR-005):
 * an odd payload yields empty text — no goal — rather than a throw.
 *
 * @param parts The message's parts, when present.
 * @returns The joined, trimmed user text; empty when there is none.
 */
function userMessageText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'object' && part !== null && part.type === 'text' && part.synthetic !== true) {
      if (typeof part.text === 'string') {
        texts.push(part.text);
      }
    }
  }
  return texts.join('\n\n').trim();
}

/**
 * Derives a solved item's short outcome (FR-014): the tool output
 * collapsed to a single line (whitespace runs become one space — each
 * memo entry must stay one line) and truncated to
 * SOLVED_OUTCOME_MAX_LENGTH characters, ellipsis included. The
 * collapse input is sliced to a bounded prefix first (review
 * iteration 2, LOW) so the per-call work is constant rather than
 * proportional to tool-output size. The
 * `tool.execute.after` typings expose no error field (only
 * title/output/metadata), so an absent or unreadable output logs the
 * brief placeholder 'completed' — the call did complete, which is all
 * the memo line claims.
 *
 * @param output The hook's output payload, when present.
 * @returns The bounded single-line outcome summary.
 */
function solvedOutcome(output: unknown): string {
  const raw =
    typeof output === 'object' && output !== null && typeof (output as { output?: unknown }).output === 'string'
      ? (output as { output: string }).output
      : '';
  // Slice to the bounded prefix BEFORE collapsing (review iteration
  // 2, LOW): constant per-call work; under-prefix outputs unchanged.
  const collapsed = raw.slice(0, SOLVED_OUTCOME_PREFIX_LENGTH).replace(/\s+/g, ' ').trim();
  if (collapsed === '') {
    return 'completed';
  }
  if (collapsed.length <= SOLVED_OUTCOME_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, SOLVED_OUTCOME_MAX_LENGTH - 3)}...`;
}

/**
 * Appends to a most-recent-bounded log — the storage side of FR-017.
 * Pushes the entry, then trims the array in place to its `cap` most
 * recent entries (the tail — the same end `buildMemo` renders from).
 *
 * Storage is trimmed to exactly the render cap with NO headroom
 * factor, a deliberate choice: `buildMemo` can never render more than
 * the cap, both bounds read the same memoLimits resolution chain
 * (session config → environment → defaults), and a lowered cap only
 * discards entries that could never render — so anything beyond the
 * cap is pure memory waste in a long session. Trimming mutates the
 * existing array (`splice`/`length`), never replacing it, so live
 * state references stay valid. A cap of zero or less keeps nothing.
 *
 * @param log The session-state log array to append to.
 * @param entry The entry to append.
 * @param cap The maximum number of entries to store.
 */
function appendBounded<T>(log: T[], entry: T, cap: number): void {
  log.push(entry);
  if (cap <= 0) {
    log.length = 0;
    return;
  }
  if (log.length > cap) {
    log.splice(0, log.length - cap);
  }
}

// ── D2: auditor side-session adapter ───────────────────────────────

// The plugin package does not re-export the SDK types, so derive them
// from the client (the .opencode/lib/agent-executor.ts convention).
type SessionPromptOptions = Parameters<PluginInput['client']['session']['prompt']>[0];
type SessionPromptResponse = Awaited<ReturnType<PluginInput['client']['session']['prompt']>>;
type SessionPromptPart = NonNullable<SessionPromptResponse['data']>['parts'][number];

/** Tool-list response shapes (tool-arg repair): `parameters` carries each tool's JSON schema. */
type ToolListResponse = Awaited<ReturnType<PluginInput['client']['tool']['list']>>;
type ToolListEntry = NonNullable<ToolListResponse['data']>[number];

/** Session-message list response shape (tool-arg repair evidence + identity fallback). */
type SessionMessagesResponse = Awaited<ReturnType<PluginInput['client']['session']['messages']>>;
type SessionMessage = NonNullable<SessionMessagesResponse['data']>[number];

/** Prompt body augmented with `variant`, which the SDK typings lag (agent-executor convention). */
type PromptBodyWithVariant = NonNullable<SessionPromptOptions['body']> & { variant?: string };

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

/**
 * Formats a failed client response for a rejection message: the error
 * payload when present, otherwise the HTTP status. Mirrors
 * agent-executor's `responseFailure`, trimmed to the adapter's needs.
 *
 * @param label What operation failed.
 * @param response The client response that carried no usable data.
 * @returns A human-readable failure description.
 */
function responseFailure(label: string, response: { error?: unknown; response?: { status?: number } }): string {
  if (response.error !== undefined && response.error !== null) {
    return `${label}: ${errorText(response.error)}`;
  }
  const status = response.response?.status;
  return status !== undefined ? `${label}: HTTP ${status}` : `${label}: missing response data`;
}

/**
 * Splits a "<provider>/<model-id>" slug the way agent-executor's
 * `directModelIdentity` does.
 *
 * @param model The configured auditor model slug.
 * @returns The provider/model pair, or null when the slug is malformed.
 */
function splitModelSlug(model: string): { providerID: string; modelID: string } | null {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    return null;
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

/**
 * Lenient response-text extraction (design D2): joins the response's
 * non-ignored text parts. Structurally defensive so a runtime shape
 * drift yields empty text (and a rejection upstream) rather than a crash.
 *
 * @param parts The prompted message's parts, when present.
 * @returns The joined, trimmed response text.
 */
function extractResponseText(parts: readonly SessionPromptPart[] | undefined): string {
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .filter((part): part is Extract<SessionPromptPart, { type: 'text' }> => part.type === 'text' && part.ignored !== true)
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

/**
 * Builds the D2 `invokeModel` adapter: each call creates a dedicated
 * auditor side session — never the supervised conversation (FR-004) —
 * and prompts it with the configured auditor model/variant, mirroring
 * `.opencode/lib/agent-executor.ts`'s session.create/session.prompt call
 * shapes. A fresh session per audit keeps the peer audit stateless per
 * call (FR-001) with no cross-audit context bleed. The side session's
 * ID is registered for hook self-suppression the moment `create`
 * resolves — before prompting — and discarded at cleanup (review
 * iteration 2, HIGH; see `auditorSessionIds`). The side session is
 * deleted on EVERY exit path (review finding #10, widened to the
 * failure paths by review iteration 2): it is ephemeral scaffolding,
 * and without deletion N persistent `supervisor-audit @ ...` sessions
 * accumulate per audit — including failed audits, which in the
 * designed degradation mode (unauthenticated auditor) is every
 * audit. Deletion runs fail-open in its own try/catch — a delete
 * failure logs, never fails the audit, and never masks the original
 * error on a failure path. Failures still reject so `runPeerAudit`'s
 * fail-open path (FR-005) records them.
 *
 * @param client The plugin input's OpenCode HTTP client.
 * @param directory The project directory scoping the side session.
 * @param logger The plugin logger (server log, FR-052).
 * @returns The InvokeModel function driving the auditor side session.
 */
export function createInvokeModel(client: PluginInput['client'], directory: string, logger?: PluginLogger): InvokeModel {
  // Review round 2 (additive signature): the logger is optional so
  // 2-arg callers from 2.4.0 keep working — without one, delete
  // failures fall back to the shared silent logger (review round 5)
  // rather than throwing.
  const log = logger ?? silentPluginLogger;
  return async (prompt: string, config: AuditConfig): Promise<string> => {
    if (config.auditorModel === undefined) {
      throw new Error('no auditor model configured');
    }
    const identity = splitModelSlug(config.auditorModel);
    if (identity === null) {
      throw new Error(`auditor model '${config.auditorModel}' is not a <provider>/<model-id> slug`);
    }
    const created = await client.session.create({
      body: {
        title: `supervisor-audit @ ${config.auditorModel}${config.auditorVariant !== undefined ? ` (${config.auditorVariant})` : ''}`,
      },
      query: { directory },
    });
    const auditorSessionID = created.data?.id;
    if (auditorSessionID === undefined) {
      throw new Error(responseFailure('auditor side session create failed', created));
    }
    // Self-suppression (review iteration 2, HIGH): register the side
    // session BEFORE prompting — from this moment its bus events must
    // not re-enter the hooks (see `auditorSessionIds`).
    auditorSessionIds.add(auditorSessionID);
    // Best-effort delete of the ephemeral side session, fail-open in
    // its own try/catch (review finding #10): a delete failure logs
    // and never fails the audit — and never masks the original error
    // when invoked from a failure path below.
    const deleteSideSession = async (): Promise<void> => {
      try {
        const deleted = await client.session.delete({ path: { id: auditorSessionID } });
        if (deleted.error !== undefined && deleted.error !== null) {
          log.error(responseFailure('auditor side session delete failed', deleted));
        }
      } catch (error) {
        log.error(`auditor side session delete failed open: ${errorText(error)}`);
      }
    };
    try {
      const body: PromptBodyWithVariant = {
        model: { providerID: identity.providerID, modelID: identity.modelID },
        parts: [{ type: 'text', text: prompt }],
      };
      if (config.auditorVariant !== undefined) {
        body.variant = config.auditorVariant;
      }
      const prompted = await client.session.prompt({
        path: { id: auditorSessionID },
        query: { directory },
        body,
      });
      if (prompted.data === undefined) {
        throw new Error(responseFailure('auditor side session prompt failed', prompted));
      }
      if (prompted.data.info.error !== undefined) {
        throw new Error(`auditor side session message error: ${errorText(prompted.data.info.error)}`);
      }
      const text = extractResponseText(prompted.data.parts);
      if (text === '') {
        throw new Error('auditor side session returned no response text');
      }
      // Success path: delete exactly once, now that the audit result
      // is secured (text extracted).
      await deleteSideSession();
      return text;
    } catch (error) {
      // Failure paths delete too (review iteration 2, MEDIUM
      // resource-leak finding): prompt transport rejection, missing
      // prompt data, in-band message error, and empty extracted text
      // all used to throw past the delete — in the designed
      // degradation mode (unauthenticated auditor) every audit takes
      // a failure path, leaking one stored session per audit. Delete
      // best-effort, then rethrow so runPeerAudit's fail-open path
      // (FR-005) records the original error as before.
      await deleteSideSession();
      throw error;
    } finally {
      // Discard the self-suppression registration with the session
      // itself: once deleted, the side session no longer exists, so
      // no further events can carry this ID.
      auditorSessionIds.delete(auditorSessionID);
    }
  };
}

/**
 * Builds the tool-arg repair model adapter: each call creates a dedicated
 * side session (never the supervised conversation) and prompts it with the
 * configured repair model, mirroring `createInvokeModel`'s call shapes —
 * self-suppression registered before prompting, the side session deleted
 * on every exit path, and transport failures rejecting so
 * `repairToolArgs`'s fail-open path records them. Differs from the auditor
 * adapter in two ways: the prompt is bounded by `timeoutMs` (a repair must
 * not stall the tool call it guards; the timeout promise wins the race and
 * the losing prompt promise has a no-op catch attached so a late transport
 * failure cannot surface as an unhandled rejection), and there is no
 * variant tier.
 *
 * @param client The plugin input's OpenCode HTTP client.
 * @param directory The project directory scoping the side session.
 * @param logger The plugin logger (server log).
 * @returns The invoker driving the repair side session.
 */
export function createRepairInvoker(
  client: PluginInput['client'],
  directory: string,
  logger?: PluginLogger
): (prompt: string, model: string, timeoutMs: number) => Promise<string> {
  const log = logger ?? silentPluginLogger;
  return async (prompt: string, model: string, timeoutMs: number): Promise<string> => {
    const identity = splitModelSlug(model);
    if (identity === null) {
      throw new Error(`repair model '${model}' is not a <provider>/<model-id> slug`);
    }
    const created = await client.session.create({
      body: { title: `supervisor-repair @ ${model}` },
      query: { directory },
    });
    const repairSessionID = created.data?.id;
    if (repairSessionID === undefined) {
      throw new Error(responseFailure('repair side session create failed', created));
    }
    // Self-suppression before prompting, mirroring `createInvokeModel`.
    auditorSessionIds.add(repairSessionID);
    // Best-effort delete of the ephemeral side session, fail-open.
    const deleteSideSession = async (): Promise<void> => {
      try {
        const deleted = await client.session.delete({ path: { id: repairSessionID } });
        if (deleted.error !== undefined && deleted.error !== null) {
          log.error(responseFailure('repair side session delete failed', deleted));
        }
      } catch (error) {
        log.error(`repair side session delete failed open: ${errorText(error)}`);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const boundedMs = Math.max(1000, timeoutMs);
      const promptCall = client.session.prompt({
        path: { id: repairSessionID },
        query: { directory },
        body: {
          model: { providerID: identity.providerID, modelID: identity.modelID },
          parts: [{ type: 'text', text: prompt }],
        },
      });
      // A late rejection of the losing prompt promise must not surface as
      // an unhandled rejection after the timeout already settled the race.
      promptCall.catch(() => {});
      const prompted = await Promise.race([
        promptCall,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`repair side session timed out after ${boundedMs}ms`)), boundedMs);
          timer.unref?.();
        }),
      ]);
      if (prompted.data === undefined) {
        throw new Error(responseFailure('repair side session prompt failed', prompted));
      }
      if (prompted.data.info.error !== undefined) {
        throw new Error(`repair side session message error: ${errorText(prompted.data.info.error)}`);
      }
      const text = extractResponseText(prompted.data.parts);
      if (text === '') {
        throw new Error('repair side session returned no response text');
      }
      await deleteSideSession();
      return text;
    } catch (error) {
      await deleteSideSession();
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      auditorSessionIds.delete(repairSessionID);
    }
  };
}

// ── Critique delivery (task 3.3; FR-007/FR-008, spike 1.2) ────────

/** One failed-audit critique bound for the supervised session. */
interface CritiqueDeliveryRequest {
  /** The supervised session that produced the failed step. */
  sessionID: string;
  /** The auditor's critique, carried verbatim under the framing prefix. */
  critique: string;
  /** Failure classification (design D3); the caller defaults absent severity to minor. */
  severity: AuditSeverity;
  /** Resolved hook config supplying the maxRegenerations bound. */
  config: HookConfig;
  /** The session's live state — critiqueCount and critiqueLog write through. */
  state: SessionState;
}

/**
 * Frames a critique for delivery (spike 1.2): a minimal, consistent
 * corrective prefix so the user-role synthetic message reads as an
 * audit finding to address rather than a fresh user request. The
 * critique itself is carried verbatim.
 *
 * @param critique The auditor's critique.
 * @returns The text of the delivered synthetic user part.
 */
function critiqueMessage(critique: string): string {
  return `[supervisor] audit finding — correct the failed step and continue:\n${critique}`;
}

/**
 * Builds the critique-delivery boundary (task 3.3) bound to the plugin
 * input's client, mirroring `createInvokeModel`'s binding. Minor
 * failures steer the supervised session's next turn (FR-007); severe
 * failures interrupt first (FR-008) — `session.abort` MUST precede the
 * delivery or it kills the corrective turn it exists to start
 * (spike 1.2). Both severities deliver through `session.promptAsync`
 * (the 204 fire-and-forget call — never the sync `session.prompt`,
 * whose HTTP response stays open for the whole steered turn) as a
 * synthetic-marked user part: V1 has no delivery option, so steer is
 * emergent (spike 1.2).
 *
 * The bound: `maxRegenerations` caps the whole intervention per
 * session — the severe abort AND the delivered critique. Critique
 * turns emit new reasoning parts that re-enter the audit pipeline, so
 * the cap is the loop guard; the live smoke test (design.md,
 * FR-008 side finding) observed the unbounded-abort wedge — after the
 * bound was spent, markers re-quoted from history kept triggering
 * aborts every turn with no escape — so the same knob now bounds the
 * abort too (decision amendment, review findings #2/#8). Over the
 * bound a severe finding neither aborts nor delivers: it is recorded
 * in `critiqueLog` as withheld (FR-015). The delivery slot is
 * reserved immediately after the bound check, before ANY await, on
 * every path (review iteration 2, MEDIUM: the `event` hook is
 * fire-and-forget and audits run concurrently, so check-and-reserve
 * must be atomic — the old severe path let two concurrent findings
 * both pass the check before either incremented). Slot release on
 * delivery failure is asymmetric: the MINOR path releases (no side
 * effect fired — only delivered critiques count), while the SEVERE
 * path keeps the slot once the abort has been attempted — the
 * intervention (interrupt) already fired, and releasing it would let
 * persistent promptAsync failures with succeeding aborts recur
 * without spending the bound, contradicting the bounded-intervention
 * amendment above. Either way the failed critique is recorded as
 * withheld; the log itself is storage-bounded to
 * `CRITIQUE_RETENTION_CAP` (FR-017; design D3 retention — deeper than
 * the memo render cap so recall reaches further; most-recent, via
 * `appendBounded`) so long sessions cannot grow it without limit.
 *
 * Never rejects (FR-005): transport rejections and in-band response
 * errors fail open — logged and recorded as undelivered — because the
 * `event` hook must not reject. `promptAsync`'s 204 means accepted,
 * not delivered; server-side fork failures surface as Event.Error bus
 * events, an accepted fail-open gap (spike 1.2).
 *
 * @param client The plugin input's OpenCode HTTP client.
 * @param logger The plugin logger (server log, FR-052).
 * @returns The delivery function the event hook awaits per failed audit.
 */
function createCritiqueDelivery(client: PluginInput['client'], logger: PluginLogger): (request: CritiqueDeliveryRequest) => Promise<void> {
  return async ({ sessionID, critique, severity, config, state }) => {
    // FR-007: at most maxRegenerations interventions per session — the
    // bound governs the whole intervention (abort AND steer). Decision
    // amendment (review findings #2/#8, smoke-test FR-008 side finding):
    // the abort previously fired unconditionally even over the bound, so
    // markers re-quoted from history kept interrupting every turn after
    // the bound was spent, wedging the session. Over the bound a severe
    // finding MUST NOT abort and MUST NOT deliver — the critique is
    // recorded as withheld (FR-015) and the delivery returns. The slot
    // reservation below follows this check immediately, before any
    // await, so check-and-reserve stays atomic under concurrent audits.
    if (state.critiqueCount >= config.maxRegenerations) {
      appendBounded(state.critiqueLog, { text: critique, severity, delivered: false }, CRITIQUE_RETENTION_CAP);
      logger.warn(
        `critique bound (${config.maxRegenerations}) reached for session ${sessionID}; ` +
          'critique recorded without delivery'
      );
      return;
    }
    // Reserve the delivery slot immediately after the bound check,
    // before ANY await, on every path (review iteration 2, MEDIUM):
    // the event hook is fire-and-forget and audits run concurrently,
    // so a reservation deferred past the severe abort's await let
    // two concurrent findings both pass the bound check. From here
    // the slot is spent; the release rules in the catch below are
    // asymmetric.
    state.critiqueCount += 1;
    // FR-008: severe findings interrupt first, before the delivery —
    // an abort after delivery kills the corrective turn (spike 1.2).
    // Under the bound only (the check above has already returned);
    // the tool guard separately blocks execution of severe findings,
    // so a spent bound still leaves that protection active.
    if (severity === 'severe') {
      try {
        const aborted = await client.session.abort({ path: { id: sessionID } });
        if (aborted.error !== undefined && aborted.error !== null) {
          // In-band HTTP error (the SDK resolves these rather than
          // rejecting); fail open — the delivery below is still attempted.
          logger.error(responseFailure('session abort failed', aborted));
        }
      } catch (error) {
        logger.error(`session abort failed open: ${errorText(error)}`);
      }
    }
    try {
      const delivered = await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: 'text', text: critiqueMessage(critique), synthetic: true }] },
      });
      if (delivered.error !== undefined && delivered.error !== null) {
        throw new Error(responseFailure('critique delivery failed', delivered));
      }
      // FR-015: record the delivered critique; the log itself is
      // storage-bounded to CRITIQUE_RETENTION_CAP (FR-017; design D3).
      appendBounded(state.critiqueLog, { text: critique, severity, delivered: true }, CRITIQUE_RETENTION_CAP);
    } catch (error) {
      // Transport failure (FR-005 fail-open): record the attempt as
      // withheld so the memo can still surface it. Slot release is
      // asymmetric (review iteration 2): the MINOR path releases the
      // reserved slot — no side effect fired, only delivered critiques
      // count; the SEVERE path keeps it — once the abort has been
      // attempted the intervention (interrupt) already fired, and
      // releasing the slot would let persistent promptAsync failures
      // with succeeding aborts recur without spending the bound,
      // contradicting the "whole intervention is bounded" amendment.
      if (severity !== 'severe') {
        state.critiqueCount -= 1;
      }
      appendBounded(state.critiqueLog, { text: critique, severity, delivered: false }, CRITIQUE_RETENTION_CAP);
      logger.error(`critique delivery failed open: ${errorText(error)}`);
    }
  };
}

// ── Experimental hook registration (D-risk "wrap registration, degrade") ──

/**
 * Hook name for the experimental message-list transform (FR-016 memo
 * injection). Wire-verified against OpenCode 1.19.0: payload mutations
 * to `output.messages` reach the model request, while
 * `experimental.chat.system.transform` mutations are discarded by that
 * build (see openspec/changes/audit-supervisor/design.md FR-016).
 */
const MESSAGES_TRANSFORM_HOOK = 'experimental.chat.messages.transform';

/**
 * Structural handler type for the experimental messages-transform
 * hook, deliberately NOT derived from `Hooks['experimental...']`: an
 * installed `@opencode-ai/plugin` whose typings drop the experimental
 * key must not break this module. The payload carries the session's
 * message list; the handler communicates by in-place mutation
 * (appending the memo message).
 */
type MessagesTransformHandler = (
  input: unknown,
  output: { messages?: unknown[] }
) => Promise<void>;

/**
 * Registers the experimental messages-transform hook through a widened
 * record inside a guarded feature check, so registration degrades
 * gracefully (D-risk "wrap registration, degrade"): a typings or
 * runtime version without the hook loads this plugin memo-less rather
 * than failing, a host that never dispatches the key leaves it inert,
 * and any registration failure is contained — the memo is an
 * enhancement, never a load requirement (fail-open supervision).
 *
 * @param hooks The hook map being assembled by `server`.
 * @param handler The memo-injection handler (FR-016).
 */
function registerMessagesTransform(hooks: Hooks, handler: MessagesTransformHandler): void {
  try {
    if (typeof handler !== 'function') {
      return;
    }
    (hooks as Record<string, unknown>)[MESSAGES_TRANSFORM_HOOK] = handler;
  } catch {
    // Memo-less degradation; never fail plugin load.
  }
}

// ── Plugin entry (design D1) ───────────────────────────────────────

/**
 * Bound on one directive file (review round 3): a planted oversized
 * file skips as unreadable instead of stalling plugin load.
 */
const MAX_DIRECTIVE_FILE_BYTES = 65536;

/**
 * Loads directive files (FR-026) from
 * `<directory>/.opencode/supervisor/directives/*.md`, sorted by
 * filename for deterministic precedence. A missing directory yields
 * no files silently — directive-less projects keep 2.1.0 behavior —
 * while an unreadable directory or file is skipped with a returned
 * warning (fail-open, FR-032; review round 1: a blanket catch hid
 * per-file failures and dropped the whole set; review round 2: the
 * warnings are RETURNED rather than logged, so the caller can defer
 * them past the bootstrap listener-down window; review round 3: each
 * read is bounded and non-blocking via `readBoundedFile`, so a
 * planted oversized or non-regular file cannot stall load). I/O lives
 * here in the hook layer (design D3); parsing is pure in
 * src/directives.ts.
 */
const loadDirectiveFiles = (
  directory: string
): { files: { name: string; content: string }[]; warnings: string[] } => {
  const warnings: string[] = [];
  const directivesDir = path.join(directory, '.opencode', 'supervisor', 'directives');
  let entries;
  try {
    entries = fs.readdirSync(directivesDir, { withFileTypes: true });
  } catch (error) {
    // ENOENT = no directives configured (expected, stays silent);
    // anything else is a real read problem worth surfacing.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`directive directory unreadable (${errorText(error)}); no file directives loaded`);
    }
    return { files: [], warnings };
  }
  // Codepoint sort (review round 1): localeCompare depends on the
  // ambient locale, which made memo order and cap survival
  // nondeterministic across environments (FR-026 determinism).
  const sorted = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: { name: string; content: string }[] = [];
  for (const entry of sorted) {
    // Review round 3: the read is bounded and non-blocking — a
    // planted oversized or non-regular directive file (a FIFO stalls
    // a plain open) skips as unreadable instead of stalling load.
    const { text, error } = readBoundedFile(
      path.join(directivesDir, entry.name),
      MAX_DIRECTIVE_FILE_BYTES,
      'directive file'
    );
    if (error !== null) {
      warnings.push(`directive file '${entry.name}' unreadable (${error}); skipped`);
    } else if (text !== null) {
      files.push({ name: entry.name, content: text });
    } else {
      warnings.push(`directive file '${entry.name}' unreadable (vanished); skipped`);
    }
  }
  return { files, warnings };
};

/**
 * Reads the engineer's approval records (FR-044) from
 * `<directory>/.opencode/supervisor/approvals.json`, fresh, for
 * a call that just matched an approve gate — approvals and
 * revocations take effect on the next matching call without a
 * restart. An absent file is the empty record set (absence is
 * the unapproved state, not an error); any other read failure,
 * or a parse failure inside `parseApprovals`, returns as an
 * error string so the gate can fail closed (FR-045) instead of
 * silently dissolving. I/O lives here (design D1); parsing and
 * matching are pure in src/gates.ts.
 */
/**
 * Bounded single-descriptor read (review round 1, LOW): opens the file
 * once and fstats the descriptor, so the size bound and the read apply
 * to the same file — a path swapped between stat and read (TOCTOU)
 * cannot slip an oversized file past the bound. An absent file is
 * reported as absent (absence is a state, not an error); an oversized
 * file reports the bound error with `what` naming the file kind; any
 * other failure returns its error text. Review round 3: the open is
 * non-blocking and non-regular files — a FIFO planted at a guarded
 * path would stall a plain open forever — report 'not a regular
 * file' instead of hanging the event loop.
 *
 * @param filePath Absolute path to read.
 * @param maxBytes The inclusive upper bound on bytes read.
 * @param what Name of the file kind, for error messages.
 * @returns The text read, or an error string; both null means absent.
 */
const readBoundedFile = (
  filePath: string,
  maxBytes: number,
  what: string
): { text: string | null; error: string | null } => {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: null, error: null };
    }
    return { text: null, error: errorText(error) };
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      return { text: null, error: `${what} is not a regular file` };
    }
    if (stats.size > maxBytes) {
      return {
        text: null,
        error: `${what} is ${stats.size} bytes, exceeding the ${maxBytes}-byte read bound`,
      };
    }
    const buffer = Buffer.alloc(stats.size);
    let read = 0;
    while (read < stats.size) {
      const count = fs.readSync(fd, buffer, read, stats.size - read, read);
      if (count === 0) break;
      read += count;
    }
    return { text: buffer.toString('utf8'), error: null };
  } catch (error) {
    return { text: null, error: errorText(error) };
  } finally {
    fs.closeSync(fd);
  }
};

// normalizePathToken and hasProtectedSegmentRun now live in
// src/tool-guard.ts (review round 4) beside checkProtectedState.

const readApprovals = (directory: string): { records: ApprovalRecord[]; error: string | null } => {
  const approvalsPath = path.join(directory, '.opencode', 'supervisor', 'approvals.json');
  // Bounded read (FR-045): a planted oversized file fails closed
  // instead of stalling the event loop.
  const { text, error } = readBoundedFile(approvalsPath, MAX_APPROVALS_FILE_BYTES, 'approvals file');
  if (error !== null || text === null) {
    return { records: [], error };
  }
  return parseApprovals(text);
};

/**
 * Reads one supervisor config file (FR-057), mirroring `readApprovals`:
 * a size-bounded read (a planted oversized file is skipped with an
 * error rather than stalling the event loop), an absent file is simply
 * absent (absence is the unconfigured state, not an error), and any
 * other read or parse failure returns as an error string so the caller
 * can warn once and skip the tier. I/O lives here (design D1); parsing
 * and validation are pure in src/config-file.ts.
 *
 * @param configPath Absolute path to the config file.
 * @returns The validated config subset, or an error string.
 */
const readSupervisorConfigFile = (configPath: string): ParsedSupervisorConfig => {
  const { text, error } = readBoundedFile(configPath, MAX_CONFIG_FILE_BYTES, 'config file');
  if (error !== null || text === null) {
    return { config: {}, error };
  }
  return parseSupervisorConfigFile(text);
};

/**
 * Resolves the global user-level config path (FR-057):
 * `${XDG_CONFIG_HOME}/opencode/supervisor/config.json`, falling back to
 * `~/.config/opencode/supervisor/config.json` when XDG_CONFIG_HOME is
 * unset or empty.
 *
 * @returns Absolute path to the global config file.
 */
const globalSupervisorConfigPath = (): string => {
  // Review round 4 (LOW): a relative XDG_CONFIG_HOME is ignored the
  // same as an unset one — path.join would otherwise rebase the
  // config path onto the plugin process's cwd.
  const xdg = process.env.XDG_CONFIG_HOME;
  const configRoot =
    xdg !== undefined && xdg.trim() !== '' && path.isAbsolute(xdg)
      ? xdg
      : path.join(homedir(), '.config');
  return path.join(configRoot, 'opencode', 'supervisor', 'config.json');
};

/**
 * Plugin server (design D1): assembles the hook map. The `event` hook
 * runs the full supervision path (tasks 3.2–3.3): synchronous dedupe →
 * strip → deterministic invariants → side-session peer audit →
 * verified-trace recording on pass, bounded critique delivery on
 * failure (steer for minor, interrupt + steer for severe). Task 3.4
 * wires the remaining supervision inputs and outputs: `chat.message`
 * captures the session goal (FR-013), `tool.execute.after` logs
 * bounded solved items (FR-014), and the experimental system
 * transform injects the supervision memo (FR-016). The tool guard
 * (task 3.5) enforces FR-009..FR-012 against the session's live
 * verified trace. Every hook is present, typed, and non-throwing,
 * except the tool guard's sanctioned block throw (spike 1.3).
 *
 * @param input The plugin input (OpenCode HTTP client, project context).
 * @param options Tuple-registration options (`[path, options]` in the
 *   `plugin` array): `options.directives` appends engineer directives
 *   after the file sources (FR-026), and `options.config` carries the
 *   options config tier (FR-056).
 * @returns The registered hooks.
 */
const server = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  // FR-052: every plugin log line routes through the server log. The
  // plugin runs inside the OpenCode server process, whose stdout/stderr
  // is the TUI terminal — console calls corrupt the display; the /log
  // endpoint files entries under the 'opencode-supervisor' service tag
  // instead. Fire-and-forget (FR-053): a listener that is not up yet at
  // bootstrap absorbs the loss.
  const logger = createPluginLogger(input.client);
  // Engineer console (FR-026..FR-032): directives are static policy
  // loaded once per plugin start — not per-session state. Files come
  // from `.opencode/supervisor/directives/*.md` in the project
  // directory; tuple registration can add `options.directives`
  // entries after them (D1). Loading is fail-open throughout
  // (FR-032): unreadable directories yield no files, malformed files
  // and invalid rules degrade to warnings, and the combined set is
  // bounded to MAX_DIRECTIVES.
  const { files: directiveFiles, warnings: directiveFileWarnings } = loadDirectiveFiles(input.directory);
  const parsedFiles = parseDirectives(directiveFiles);
  const parsedOptions = parseOptionsDirectives(options?.directives);
  const allDirectives = [...parsedFiles.directives, ...parsedOptions.directives];
  const directives: Directive[] = allDirectives.slice(0, MAX_DIRECTIVES);
  const directiveWarnings = [
    ...parsedFiles.warnings,
    ...parsedOptions.warnings,
    ...(allDirectives.length > MAX_DIRECTIVES
      ? [`${allDirectives.length - MAX_DIRECTIVES} directive(s) beyond the cap of ${MAX_DIRECTIVES} dropped`]
      : []),
  ];
  // D6: compiled enforcement feeds the tool guard (FR-028); the
  // rendered advisory feeds the peer-audit prompt (FR-031).
  const { enforcement, warnings: compileWarnings } = compileEnforcement(directives);
  // D1/D6: approve and review gates compile from the same
  // directive set (FR-043..FR-048); their warnings join the
  // load-time stream.
  const { gates: compiledGates, warnings: gateWarnings } = compileGates(directives);
  const directivesAdvisory = renderDirectivesAdvisory(directives);
  // Deferred bootstrap warnings (review round 1, MEDIUM): warnings
  // collected during server() fire into the listener-down window,
  // where fire-and-forget delivery (FR-053) loses them and dedupe
  // (FR-054) would suppress the repeat. They queue here and flush at
  // first-hook time in `buildConfig` — the identity-line precedent
  // (design D3), when the HTTP listener is reliably up.
  const bootstrapWarnings = [
    ...directiveFileWarnings,
    ...directiveWarnings,
    ...compileWarnings,
    ...gateWarnings,
  ];
  let bootstrapFlushed = false;
  // FR-057: file config tiers, read once per plugin start. An absent
  // file is the unconfigured state (silent); a present-but-invalid
  // file is skipped with one warning — the tier dissolves, lower tiers
  // and defaults remain in effect (fail-open, mirroring FR-032).
  const projectFile = readSupervisorConfigFile(
    path.join(input.directory, '.opencode', 'supervisor', 'config.json')
  );
  if (projectFile.error !== null) {
    bootstrapWarnings.push(`project supervisor config file ignored: ${projectFile.error}`);
  }
  const globalFile = readSupervisorConfigFile(globalSupervisorConfigPath());
  if (globalFile.error !== null) {
    bootstrapWarnings.push(`global supervisor config file ignored: ${globalFile.error}`);
  }
  // FR-056 options tier: `options.config` from tuple registration,
  // validated like the file tiers (a wrong-typed value rejects the
  // whole tier with one warning).
  const optionsParsed = validateSupervisorConfig(
    (options as (PluginOptions & { config?: unknown }) | undefined)?.config ?? {}
  );
  if (optionsParsed.error !== null) {
    bootstrapWarnings.push(`plugin options supervisor config ignored: ${optionsParsed.error}`);
  }
  const optionsConfig = optionsParsed.config;
  // Tool-arg repair mode (static registration-time tier): 'full' keeps the
  // whole supervision pipeline; 'repair-only' disables the audit/guard/memo
  // features so the plugin only repairs malformed tool arguments. Same tier
  // order as resolveHookConfig (environment → project file → plugin options
  // → global file → default); no derived tier — mode is never derived.
  const mode: SupervisorMode =
    pickSupervisorMode(envText(ENV_MODE)) ??
    tiered(projectFile.config.mode, optionsConfig.mode, globalFile.config.mode) ??
    'full';
  const repairOnly = mode === 'repair-only';
  // FR-058 derived tier: the OpenCode config's model (small_model
  // preferred) when no earlier tier set one. Lazy and memoized on
  // success only — a failed lookup (the server's HTTP listener may
  // not be up yet at plugin load) is retried on the next resolution.
  // Review round 2 (MEDIUM): the lookup is bounded by a timeout so a
  // hanging endpoint cannot stall every hook, and a persistently
  // failing endpoint is retried with a backoff instead of on every
  // hook — eventual consistency, bounded work.
  const DERIVED_LOOKUP_TIMEOUT_MS = 5000;
  const DERIVED_LOOKUP_FAILURE_BUDGET = 5;
  const DERIVED_LOOKUP_BACKOFF_MS = 60000;
  let derivedModel: string | undefined;
  let derivedModelResolved = false;
  let derivedLookupFailed = false;
  let derivedConsecutiveFailures = 0;
  let derivedNextAttemptAt = 0;
  const resolveDerivedModel = async (): Promise<string | undefined> => {
    if (derivedModelResolved) {
      return derivedModel;
    }
    if (derivedConsecutiveFailures >= DERIVED_LOOKUP_FAILURE_BUDGET && Date.now() < derivedNextAttemptAt) {
      derivedLookupFailed = true;
      return derivedModel;
    }
    // Review round 3 (LOW): the losing timeout timer is cleared on
    // every path, so a fast success does not leave it pending.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        input.client.config.get({ query: { directory: input.directory } }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('config.get timed out')), DERIVED_LOOKUP_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      // Review round 4 (LOW): an empty-string `small_model` is not
      // nullish, so a naive `??` would swallow the `model` fallback
      // and mark the lookup resolved with no model — treat blank
      // values as unset for both candidates.
      const smallModel = response.data?.small_model;
      const fullModel = response.data?.model;
      const model =
        typeof smallModel === 'string' && smallModel.trim() !== ''
          ? smallModel
          : typeof fullModel === 'string' && fullModel.trim() !== ''
            ? fullModel
            : undefined;
      if (model !== undefined) {
        derivedModel = model;
      }
      derivedModelResolved = true;
      derivedLookupFailed = false;
      derivedConsecutiveFailures = 0;
    } catch {
      // The listener may be down (bootstrap); retry on the next call —
      // but after a run of consecutive failures, back off first.
      derivedLookupFailed = true;
      derivedConsecutiveFailures += 1;
      if (derivedConsecutiveFailures >= DERIVED_LOOKUP_FAILURE_BUDGET) {
        derivedNextAttemptAt = Date.now() + DERIVED_LOOKUP_BACKOFF_MS;
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    return derivedModel;
  };
  // Per-use config resolution (FR-056): every hook resolves the
  // effective config through this builder, applying the file/options
  // tiers and, when no earlier tier set a model, the derived tier.
  // Also carries the identity line (FR-055): logged once per process
  // on the FIRST hook-time resolution — by then the HTTP listener is
  // up, so the line reliably reaches the server log (a load-time
  // attempt could fire before the listener existed).
  const buildConfig = async (): Promise<HookConfig> => {
    const sources: SupervisorConfigSources = {
      project: projectFile.config,
      global: globalFile.config,
      options: optionsConfig,
      // Review round 2 (LOW): seeding the memoized derived model
      // keeps the steady state to a single resolution pass per hook.
      derivedModel: derivedModelResolved ? derivedModel : undefined,
    };
    let config = resolveHookConfig(undefined, sources);
    if (config.auditorModel === undefined && !derivedModelResolved) {
      const derived = await resolveDerivedModel();
      if (derived !== undefined) {
        config = resolveHookConfig(undefined, { ...sources, derivedModel: derived });
      }
    }
    // Deferred bootstrap warnings (review round 1, MEDIUM): flush on
    // the FIRST hook of THIS server instance — the identity-line
    // precedent (design D3), when the HTTP listener is reliably up.
    // Per-instance, because the identity line itself is
    // once-per-process: a second server() in the same process (tests
    // re-registering the plugin) still owns its own deferred
    // warnings, which must not be swallowed by an identity line
    // another instance already emitted.
    if (!bootstrapFlushed) {
      bootstrapFlushed = true;
      for (const warning of bootstrapWarnings.splice(0)) {
        logger.warn(warning);
      }
    }
    if (!logIdentityState.identityLogged) {
      logIdentityState.identityLogged = true;
      // Review round 1 (HIGH): the identity line also reports the
      // guard toggles and which bootstrap config tiers contributed
      // knobs — a flipped toggle or an applied file is otherwise
      // completely silent (only failures warn).
      const configTiers: string[] = [];
      if (Object.keys(projectFile.config).length > 0) {
        configTiers.push('project file');
      }
      if (Object.keys(globalFile.config).length > 0) {
        configTiers.push('global file');
      }
      if (Object.keys(optionsConfig).length > 0) {
        configTiers.push('plugin options');
      }
      logger.info(
        `v${PLUGIN_VERSION} loaded (mode: ${config.mode}, auditor: ${
          config.auditorModel ?? (derivedLookupFailed ? 'pending host lookup' : 'none — LLM audit disabled')
        }, variant: ${config.auditorVariant ?? 'unset'}${
          directives.length > 0 ? `, directives: ${directives.length}` : ''
        }, guards: blockRewardHacking=${config.blockRewardHacking}, stepReference=${
          config.requireStepReferenceInTools
        }${configTiers.length > 0 ? `, config: ${configTiers.join(' + ')}` : ''})`
      );
      logIdentityState.identitySaidNoModel = config.auditorModel === undefined;
    }
    if (config.auditorModel === undefined) {
      // Review round 1 (MEDIUM): distinguish a failed host lookup
      // (retrying, the frozen 'none' was premature) from an
      // authoritative absence, so the log states which it is.
      if (derivedLookupFailed) {
        logger.warn(
          'LLM peer audit disabled: host model lookup failed — will retry on the next event (deterministic invariants remain active)'
        );
      } else {
        logger.warn('LLM peer audit disabled: no auditor model configured (deterministic invariants remain active)');
      }
    } else if (logIdentityState.identitySaidNoModel) {
      // Review round 1 (MEDIUM): a late-resolving model (the FR-058
      // retry path) must not leave the frozen 'none' as the last
      // word — the enabling is announced.
      logIdentityState.identitySaidNoModel = false;
      logger.info(`auditor model resolved: ${config.auditorModel} — LLM peer audit enabled`);
    }
    return config;
  };
  // D2 adapter (task 3.2): the live audit path's invokeModel, bound
  // once per plugin load to this input's client and project directory
  // (the PluginInput identity the SDK client scopes its queries by).
  // Every audit drives a dedicated auditor side session scoped to the
  // same directory as the supervised conversation (FR-004); tests
  // substitute the client to exercise the path without a network.
  const invokeModel = createInvokeModel(input.client, input.directory, logger);
  // Task 3.3: the critique-delivery boundary, bound to the same client
  // so failed audits steer (or interrupt + steer) the supervised
  // session through the transports spike 1.2 confirmed. It enforces the
  // maxRegenerations bound, records every critique (FR-015), and never
  // rejects (FR-005).
  const deliverCritique = createCritiqueDelivery(input.client, logger);

  // ── Tool-arg repair (arg-repair feature) ──────────────────────────

  // Directive `repair` rules extend the configured argRepair scope by
  // tool name or glob — the only way to cover MCP and plugin tools the
  // default builtin list cannot name.
  const repairToolMatchers = compileRepairTools(directives);

  /** Repair notices log once per key per session, so repeated skips do not spam the log. */
  const noticeOnce = (state: SessionState, key: string, message: string): void => {
    if (state.repairNotices.has(key)) {
      return;
    }
    state.repairNotices.add(key);
    logger.warn(message);
  };

  // Tool schemas are fetched once per provider/model and memoized — the
  // promise (including a null failure result) is cached, so a degraded
  // endpoint costs at most one lookup per key per process (the
  // derived-lookup precedent: eventual consistency, bounded work).
  const toolSchemaCache = new Map<string, Promise<ToolListEntry[] | null>>();
  const fetchToolSchemas = (providerID: string, modelID: string): Promise<ToolListEntry[] | null> => {
    const key = `${providerID}/${modelID}`;
    const cached = toolSchemaCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const lookup = (async (): Promise<ToolListEntry[] | null> => {
      try {
        const response = await input.client.tool.list({
          query: { directory: input.directory, provider: providerID, model: modelID },
        });
        if (!Array.isArray(response.data)) {
          throw new Error(responseFailure('tool schema lookup failed', response));
        }
        return response.data;
      } catch (error) {
        logger.warn(`tool-arg repair: tool schemas unavailable for ${key}: ${errorText(error)}`);
        return null;
      }
    })();
    toolSchemaCache.set(key, lookup);
    return lookup;
  };

  const invokeRepairModel = createRepairInvoker(input.client, input.directory, logger);

  /**
   * Finds the message carrying the tool part for `callID`. The in-progress
   * assistant message is persisted before the tool executes, so the lookup
   * is safe from inside `tool.execute.before`.
   */
  const findToolMessage = async (sessionID: string, callID: string): Promise<SessionMessage | undefined> => {
    try {
      const response = await input.client.session.messages({ path: { id: sessionID } });
      const messages = response.data;
      if (!Array.isArray(messages)) {
        return undefined;
      }
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message === undefined) {
          continue;
        }
        if (message.parts.some((part) => part?.type === 'tool' && part.callID === callID)) {
          return message;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  /** Reasoning/text evidence from the message that emitted the tool call. */
  const collectRepairEvidence = async (sessionID: string, callID: string): Promise<string> => {
    const message = await findToolMessage(sessionID, callID);
    if (message === undefined) {
      return '';
    }
    return message.parts
      .filter(
        (part) =>
          (part?.type === 'reasoning' || part?.type === 'text') && typeof part.text === 'string' && part.text !== ''
      )
      .map((part) => part.text)
      .join('\n\n');
  };

  /** Model-identity fallback when no `chat.message` payload captured it. */
  const fallbackModelIdentity = async (
    sessionID: string,
    callID: string
  ): Promise<{ providerID: string; modelID: string } | null> => {
    const message = await findToolMessage(sessionID, callID);
    if (message === undefined || message.info.role !== 'assistant') {
      return null;
    }
    const { providerID, modelID } = message.info;
    if (providerID === '' || modelID === '') {
      return null;
    }
    return { providerID, modelID };
  };

  /**
   * The `tool.execute.before` repair pass. Runs FIRST — before the guard —
   * so the guard sees repaired arguments, and never throws: every failure
   * path (including unrepairable args) fails open, leaving opencode's own
   * schema error to reach the model.
   */
  const runArgRepair = async (
    hookInput: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
    state: SessionState
  ): Promise<void> => {
    const config = await buildConfig();
    const argRepair = config.argRepair;
    if (!argRepair.enabled) {
      return;
    }
    const toolName = hookInput.tool;
    const inScope =
      argRepair.tools.includes('*') ||
      argRepair.tools.some((name) => name.toLowerCase() === toolName.toLowerCase()) ||
      matchRepairTools(repairToolMatchers, toolName);
    if (!inScope) {
      return;
    }
    // The plugin's own console tools never need repair.
    if (!repairOnly && hooks.tool !== undefined && Object.prototype.hasOwnProperty.call(hooks.tool, toolName)) {
      return;
    }
    // In-place mutation only works on plain-object args; primitives cannot
    // be repaired through the hook output.
    if (!isPlainObject(output.args)) {
      noticeOnce(
        state,
        `args-not-object:${toolName}`,
        `tool-arg repair: arguments for '${toolName}' are not an object; skipped`
      );
      return;
    }
    const identity = state.modelIdentity ?? (await fallbackModelIdentity(hookInput.sessionID, hookInput.callID));
    if (identity === null) {
      noticeOnce(
        state,
        `no-identity:${hookInput.sessionID}`,
        `tool-arg repair: no model identity for session '${hookInput.sessionID}'; skipped`
      );
      return;
    }
    const toolsList = await fetchToolSchemas(identity.providerID, identity.modelID);
    if (toolsList === null) {
      return; // fetchToolSchemas already logged the failure.
    }
    const toolDef = toolsList.find((entry) => entry.id === toolName);
    if (toolDef === undefined) {
      noticeOnce(
        state,
        `no-schema:${toolName}`,
        `tool-arg repair: no schema advertised for tool '${toolName}'; skipped`
      );
      return;
    }
    let invoker: RepairInvoker | null = null;
    if (argRepair.model !== undefined) {
      if (state.repairAttempts >= argRepair.maxPerSession) {
        noticeOnce(
          state,
          'repair-bound',
          `tool-arg repair: per-session bound of ${argRepair.maxPerSession} reached; malformed arguments now fail normally`
        );
      } else {
        const model = argRepair.model;
        invoker = (prompt: string): Promise<string> => {
          state.repairAttempts += 1;
          return invokeRepairModel(prompt, model, argRepair.timeoutMs);
        };
      }
    }
    const outcome = await repairToolArgs(output.args, toolDef.parameters, invoker, {
      tool: toolName,
      getEvidence: () => collectRepairEvidence(hookInput.sessionID, hookInput.callID),
    });
    if (outcome.status === 'repaired' && outcome.args !== undefined) {
      const applied = mergeArgsInPlace(output.args, outcome.args);
      if (!applied) {
        logger.warn(`tool-arg repair: repaired arguments for '${toolName}' could not be applied in place`);
        return;
      }
      logger.info(`repaired tool '${toolName}' arguments via ${outcome.method}`);
      if (!repairOnly) {
        appendBounded(
          state.solvedItems,
          { tool: toolName, outcome: `arguments repaired (${outcome.method})` },
          SOLVED_RETENTION_CAP
        );
      }
      return;
    }
    if (outcome.status === 'unrepairable') {
      logger.warn(`tool '${toolName}' arguments unrepairable: ${outcome.reason}`);
      return;
    }
    if (outcome.status === 'error') {
      logger.warn(`tool-arg repair failed open for '${toolName}': ${outcome.reason}`);
    }
  };

  /**
   * Waits for the session's in-flight audit continuations, bounded by
   * `traceAwaitState.timeoutMs` (FR-067, design D8). A rejected
   * continuation counts as settled: `allSettled` never rethrows into
   * the hook, each observed rejection is logged once, and the caller
   * re-checks the live trace. The timer is cleared on every path (the
   * round-3 derived-lookup precedent). Returns 'settled' or 'timeout'.
   */
  const waitForPendingAudits = async (
    pending: Map<Promise<unknown>, string[]>
  ): Promise<'settled' | 'timeout'> => {
    const pendingList = [...pending.keys()];
    const settled = Promise.allSettled(pendingList);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), traceAwaitState.timeoutMs);
    });
    try {
      const winner = await Promise.race([settled.then(() => 'settled' as const), timeout]);
      if (winner === 'settled') {
        const results = await settled;
        for (const result of results) {
          if (result.status === 'rejected') {
            logger.warn(`in-flight audit continuation rejected while a tool call waited: ${errorText(result.reason)}`);
          }
        }
      }
      return winner;
    } finally {
      clearTimeout(timer);
    }
  };

  const hooks: Hooks = {
    /**
     * Reasoning observation (design D1; spike 1.1, tasks 3.2–3.3).
     * Fire-and-forget: the runtime never awaits a rejection here, so
     * the body catches everything and the returned promise never
     * rejects. Dedupe runs synchronously before any async work
     * (FR-001); the audit then strips narrative (FR-002), runs the
     * deterministic invariants and the side-session peer audit, records
     * passed steps in the verified trace (FR-006), and hands failed
     * audits to the critique-delivery boundary (FR-007/FR-008): steer
     * for minor, interrupt + steer for severe, bounded and recorded.
     */
    event: async ({ event }) => {
      try {
        // Switch on event.type: undeclared types (message.part.delta
        // and friends) arrive at runtime and are not errors (spike 1.1).
        if (event.type !== 'message.part.updated') {
          return;
        }
        const part = event.properties.part;
        // Self-suppression FIRST (review iteration 2, HIGH): the
        // plugin's own side sessions share this directory, so their
        // bus events reach this hook — without this check the
        // auditor's reasoning parts would be audited recursively,
        // recorded as state, and steerable. See `auditorSessionIds`.
        if (isAuditorSessionId(part.sessionID)) {
          return;
        }
        // Completed reasoning parts only: the terminal publication
        // carries the full text once time.end is set (spike 1.1).
        if (part.type !== 'reasoning' || part.time.end === undefined) {
          return;
        }
        const state = sessionState.get(part.sessionID);
        const partKey = `${part.sessionID}:${part.messageID}:${part.id}`;
        if (state.seenParts.has(partKey)) {
          return; // FR-001: duplicate audits are structurally impossible.
        }
        state.seenParts.add(partKey);
        // Task 3.2 — the live audit path. FR-002: strip narrative per
        // config.stripMode BEFORE the invariant checks, the audit, and
        // trace matching; each completed part contributes one step.
        // FR-070 (design D3): the entry carries the stripped step's
        // path tokens in a box the continuation fills once the strip
        // resolves — registration stays synchronous with the dispatch
        // (FR-067's wait contract), and a waiter reading before the
        // strip completes sees no coverage (fail-closed). The
        // continuation (config → strip → audit → trace mutation /
        // critique delivery) still resolves only after the trace
        // mutation, and the finally deregistration keeps the map
        // from leaking.
        const stepTokens: string[] = [];
        const continuation = (async () => {
          const config = await buildConfig();
          const [stepText] = stripNarrative([part.text], config.stripMode);
          // A bounded loop, never spread-into-push: an adversarial
          // step could otherwise exceed the argument-count limit
          // (review iteration 2).
          for (const token of stepText ? extractPathTokens(stepText) : []) {
            stepTokens.push(token);
          }
          // Nothing formal survives stripping: no audit, no model call,
          // nothing recorded (runPeerAudit would no-op; skip even that).
          if (stepText === undefined || stepText === '') {
            return;
          }
          // Deterministic invariants (FR-003) short-circuit inside
          // runPeerAudit before the side-session call; the goal (FR-013,
          // captured by `chat.message`) scopes drift findings whenever
          // present, and the engineer directives (FR-031) add violation
          // criteria whenever configured.
          const outcome = await runPeerAudit([stepText], config, invokeModel, state.goal, directivesAdvisory ?? undefined);
          // FR-006/FR-063: the step joins the verified trace whenever the
          // outcome records — passed steps and minor deterministic-invariant
          // failures alike (the latter marked `passed: false`, since the
          // trace is a path ledger and a misstated tally does not revoke the
          // part's file reasoning). Severe findings and peer failures evict
          // (`outcomeRecordsStep`); fail-open outcomes pass (FR-005), so a
          // degraded auditor never fences the session's tools.
          if (outcomeRecordsStep(outcome)) {
            state.verifiedSteps.push({ text: stepText, passed: outcome.passed });
            if (outcome.error !== undefined) {
              logger.warn(`peer audit failed open; step recorded as passed: ${outcome.error}`);
            }
          }
          if (!outcome.passed) {
            // Task 3.3 — critique delivery (FR-007/FR-008; spike 1.2). A
            // minor invariants failure that stayed in the trace still gets
            // its steering critique. An absent severity defaults to minor
            // (design D3, fail-open conservatism: the bounded steer, never
            // the interrupt).
            await deliverCritique({
              sessionID: part.sessionID,
              critique: outcome.critique,
              severity: outcome.severity ?? 'minor',
              config,
              state,
            });
          }
        })();
        // FR-070 (design D3): the entry carries the stripped step's
        // path tokens — the shared grammar, so "the step names the
        // path" and "the guard demands the path" agree by construction.
        state.pendingAudits.set(continuation, stepTokens);
        try {
          // Fire-and-forget contract (spike 1.3) preserved: the outer
          // catch observes any rejection; a waiting tool call observes
          // it through `waitForPendingAudits` (logged once there).
          await continuation;
        } finally {
          state.pendingAudits.delete(continuation);
        }
      } catch (error) {
        logger.error(`event hook failed: ${errorText(error)}`);
      }
    },

    /**
     * Goal capture (design D1; task 3.4): the FIRST user message of
     * the session becomes the goal (FR-013) — the audit's scope-drift
     * reference and the memo's "Session goal" line (FR-016). Never
     * replaced once set. Only user-role messages qualify (checked at
     * runtime — the typings type the payload as UserMessage, but a
     * host oddity could carry another role), and only their
     * non-synthetic text parts count: synthetic parts are plugin/host
     * injections, not user input. Whitespace-only text is no goal.
     * Fail-open (FR-005): odd payloads are logged, never thrown.
     */
    'chat.message': async (hookInput, output) => {
      try {
        // Self-suppression first (see `auditorSessionIds`): the audit
        // prompt must never become a side session's goal.
        if (isAuditorSessionId(hookInput.sessionID)) {
          return;
        }
        if (output?.message?.role !== 'user') {
          return; // not a user message (or an odd payload) — no goal
        }
        const state = sessionState.get(hookInput.sessionID);
        // Tool-arg repair: capture the session's model identity in every
        // mode — it drives the per-model tool-schema lookup.
        const model = hookInput.model;
        if (
          model !== undefined &&
          typeof model.providerID === 'string' &&
          model.providerID !== '' &&
          typeof model.modelID === 'string' &&
          model.modelID !== ''
        ) {
          state.modelIdentity = { providerID: model.providerID, modelID: model.modelID };
        }
        if (repairOnly) {
          return; // goal capture is audit-pipeline state; repair-only skips it
        }
        if (state.goal !== undefined) {
          return; // FR-013: the first user message wins, permanently
        }
        const text = userMessageText(output?.parts);
        if (text === '') {
          return; // whitespace-only or absent text is no goal
        }
        state.goal = text;
      } catch (error) {
        logger.error(`chat.message hook failed open: ${errorText(error)}`);
      }
    },

    /**
     * Tool guard (design D1; task 3.5; spike 1.3): verifies every
     * tool call's intent (FR-009..FR-012) before execution against
     * the session's live verified trace — the same stripped,
     * audit-passed steps the `event` hook records (FR-006); the trace
     * and the guard config resolve per call. Throwing is the
     * sanctioned block (spike 1.3): the rejection preserves the
     * message, which becomes the tool-error result the model sees and
     * can self-correct from (FR-012). Guard infrastructure itself
     * fails open (FR-005) — only the deliberate block throw ever
     * rejects.
     */
    'tool.execute.before': async (hookInput, output) => {
      let verification: ToolVerificationResult;
      try {
        // Self-suppression first (see `auditorSessionIds`): the
        // plugin's own side sessions are not supervised conversations
        // to fence.
        if (isAuditorSessionId(hookInput.sessionID)) {
          return;
        }
        // The session's live verified trace (FR-006): the same array
        // the event hook pushes stripped, passed steps onto, so the
        // guard sees every step as soon as its audit completes.
        // FR-029: trigger rules are evaluated on every call — a
        // blocked call still records its trigger, because the
        // attempt itself is signal; recording happens before the
        // guard decision so neither path loses it.
        const state = sessionState.get(hookInput.sessionID);
        // Tool-arg repair runs FIRST (arg-repair feature): malformed
        // arguments are repaired in place before the guard so the guard —
        // and the tool itself — see the repaired values. Fail-open: a
        // repair crash never blocks the call.
        try {
          await runArgRepair(hookInput, output, state);
        } catch (error) {
          logger.warn(`tool-arg repair failed open: ${errorText(error)}`);
        }
        if (repairOnly) {
          return;
        }
        const argPaths = extractPolicyPaths(output.args);
        for (const id of matchTriggers(directives, hookInput.tool, argPaths)) {
          if (!state.triggeredDirectives.includes(id)) {
            state.triggeredDirectives.push(id);
            // Design III observability (review round 1): triggers are
            // logged like blocks — the engineer sees when policy
            // surfaced without watching the memo.
            logger.info(`directive '${id}' triggered by tool '${hookInput.tool}'`);
          }
        }
        // FR-067 (design D8): config and the console-tool set resolve
        // once per call; `runGuard` re-runs the pure check against the
        // live trace after a settled wait without re-resolving config.
        const guardConfig = await buildConfig();
        const consoleTools = new Set(hooks.tool !== undefined ? Object.keys(hooks.tool) : []);
        const runGuard = () =>
          verifyToolIntent(
            { name: hookInput.tool, arguments: output.args },
            // FR-010 path ledger: the guard matches against recorded step
            // text. Entries map to text here — a minor-failed entry keeps
            // its file reasoning visible to the guard (FR-063) — keeping
            // verifyToolIntent's pure-module signature on plain strings.
            state.verifiedSteps.map((entry) => entry.text),
            guardConfig,
            enforcement,
            // FR-065 (design D7): the plugin's own console tools skip the
            // file-path trace check. Derived from the registered tool map —
            // the same source the gate exemption below uses — so a future
            // console tool is exempt automatically; the reward-hacking
            // check inside the guard still applies to them.
            consoleTools
          );
        verification = runGuard();
        // FR-067 (design D8) + FR-070 (design D4/D5): await-on-miss.
        // A trace block with an in-flight audit continuation means the
        // reasoning that would reference these paths may not have
        // settled when the call arrived (same-turn interleave). One
        // bounded wait per call (`traceAwaitState.timeoutMs`); a
        // settled wait re-runs the guard against the settled trace,
        // and a rejected continuation still counts as settled.
        // Reward-hacking and directive blocks never charge the wait
        // (their causes are not trace races), and the empty-trace
        // allow (FR-011) never waits. A timed-out wait fails open —
        // the live agent's progress outranks one unverified call —
        // bounded per session by `maxTimeoutFailOpens`; past the cap
        // it blocks, naming the still-unsettled audit so the model
        // can wait and retry. When the blocked token is provably
        // named by an in-flight audit's step text (a covered wait),
        // the timeout charges `maxCoveredTimeoutFailOpens` instead —
        // the correction is in flight, so the retry loop ends rather
        // than hard-blocking (FR-070, design D4).
        if (
          !verification.allowed &&
          verification.blockedCheck === 'trace' &&
          state.pendingAudits.size > 0
        ) {
          // FR-070 (design D5): snapshot before the wait so a settled
          // wait can distinguish an evicted correction from absent
          // reasoning.
          const before = new Map(state.pendingAudits);
          const unmatched = verification.unmatchedToken;
          const wait = await waitForPendingAudits(state.pendingAudits);
          if (wait === 'settled') {
            verification = runGuard();
            // FR-070 (design D5): the correction was reasoned and
            // audited but did not record — say so instead of blaming
            // absent reasoning. Attribution follows the re-run
            // verdict's own token (review iteration 2): it names
            // what is blocked NOW, where the pre-wait token names
            // what was blocked before the wait.
            const freshUnmatched = verification.unmatchedToken ?? unmatched;
            if (
              !verification.allowed &&
              verification.blockedCheck === 'trace' &&
              freshUnmatched !== undefined
            ) {
              const evicted = [...before.keys()]
                .filter((promise) => !state.pendingAudits.has(promise))
                .some((promise) => isTokenCovered(freshUnmatched, before.get(promise) ?? []));
              if (evicted) {
                verification = {
                  allowed: false,
                  reason: `Tool '${hookInput.tool}' blocked by the file-path trace check: recent reasoning named '${freshUnmatched}' but its audit did not pass, so it is not in the verified trace. Restate the step factually so it survives audit, then retry once that audit settles.`,
                  blockedCheck: 'trace',
                  unmatchedToken: freshUnmatched
                };
              }
            }
          } else {
            // FR-070 (design D4): coverage is decided at timeout — by
            // then the strip has long filled the step-token box, and a
            // wait whose blocked token an in-flight audit provably
            // names charges its own bounded budget instead of the
            // uncovered one.
            const covered =
              unmatched !== undefined &&
              [...before.values()].some((tokens) => isTokenCovered(unmatched, tokens));
            if (covered) {
              state.coveredTimeoutFailOpens += 1;
              if (state.coveredTimeoutFailOpens > guardConfig.maxCoveredTimeoutFailOpens) {
                verification = {
                  allowed: false,
                  reason: `Tool '${hookInput.tool}' blocked by the file-path trace check: an earlier reasoning audit is still unsettled after ${traceAwaitState.timeoutMs} ms and the session's covered timeout fail-open cap (${guardConfig.maxCoveredTimeoutFailOpens}) is reached. Wait for the audit to settle, then retry.`,
                  blockedCheck: 'trace',
                  unmatchedToken: unmatched
                };
              } else {
                logger.warn(
                  `trace-check wait timed out on a covered token; failing open (${state.coveredTimeoutFailOpens}/${guardConfig.maxCoveredTimeoutFailOpens}): tool '${hookInput.tool}'`
                );
                verification = {
                  allowed: true,
                  reason: 'Trace-check wait timed out; the blocked path is named by an in-flight audit and the call failed open within the covered per-session cap.',
                };
              }
            } else {
              state.timeoutFailOpens += 1;
              if (state.timeoutFailOpens > guardConfig.maxTimeoutFailOpens) {
                verification = {
                  allowed: false,
                  reason: `Tool '${hookInput.tool}' blocked by the file-path trace check: an earlier reasoning audit is still unsettled after ${traceAwaitState.timeoutMs} ms and the session's timeout fail-open cap (${guardConfig.maxTimeoutFailOpens}) is reached. Wait for the audit to settle, then retry.`,
                  blockedCheck: 'trace',
                  unmatchedToken: unmatched
                };
              } else {
                logger.warn(
                  `trace-check wait timed out; failing open (${state.timeoutFailOpens}/${guardConfig.maxTimeoutFailOpens}): tool '${hookInput.tool}'`
                );
                verification = {
                  allowed: true,
                  reason: 'Trace-check wait timed out; the call failed open within the per-session cap.',
                };
              }
            }
          }
        }
        // Directive gates (FR-043..FR-047; design D2): evaluated
        // only when the guard allows, so a forbidden path never
        // reaches the gate question. The approvals file is
        // engineer-authored state: the supervised agent may not
        // touch it (FR-044), or it could self-approve. Approve
        // gates match purely first (calls with no approve rules pay
        // no serialization and no I/O); the approvals file is read
        // fresh ONLY on a match, and verification fails closed on
        // read or parse errors (FR-045) — unlike the load-time
        // fail-open of FR-032. Every matching gate is verified, so
        // overlapping policy cannot hide behind one approved broad
        // gate. Review gates then require a trace reference for
        // every gated path they touch (FR-047), including on an
        // empty trace. The plugin's own console tools are exempt —
        // derived from the registered tool map, so a future sixth
        // tool is exempt automatically: the review gate's
        // corrective instruction points at request_audit, so the
        // gate must leave the supervision channel itself open.
        if (
          verification.allowed &&
          !(hooks.tool !== undefined && Object.prototype.hasOwnProperty.call(hooks.tool, hookInput.tool))
        ) {
          // FR-044/FR-061: the approvals file, the supervisor
          // config files, the directives directory, and the whole
          // supervisor state directory are engineer-authored state —
          // agent tool calls touching them are blocked. Review
          // round 4 moved the matching into `checkProtectedState`
          // (src/tool-guard.ts): a normalized path-token lens with
          // a content-key blocklist for non-bash tools, paired with
          // a bash-only command-string scan. Block reasons name the
          // protected object for the engineer, never the spelling
          // the agent used.
          const protectedReason = checkProtectedState(hookInput.tool, output.args, argPaths);
          if (protectedReason !== null) {
            verification = {
              allowed: false,
              reason: `Tool '${hookInput.tool}' blocked by the supervisor: ${protectedReason}`,
            };
          }
          if (verification.allowed && compiledGates.approve.length > 0) {
            const rawArgs = JSON.stringify(output.args ?? {});
            const approveMatches = matchApproveGates(
              compiledGates.approve,
              hookInput.tool,
              rawArgs,
              argPaths
            );
            if (approveMatches.length > 0) {
              // FR-045: once a gate has matched, its check must not
              // silently dissolve — unexpected failures here fail
              // closed, unlike the fail-open catch below (FR-005).
              try {
                const approval = readApprovals(input.directory);
                for (const approveMatch of approveMatches) {
                  const decision = evaluateApproveGate(
                    approveMatch,
                    hookInput.tool,
                    approval.records,
                    approval.error
                  );
                  if (decision.allowed) {
                    // FR-046: log the grant once per gate key
                    // (design D6, following the first-trigger
                    // precedent), naming directive + gate + tool.
                    if (!state.grantedGates.has(approveMatch.key)) {
                      state.grantedGates.add(approveMatch.key);
                      logger.info(
                        `gate '${approveMatch.key}' of directive '${approveMatch.directiveId}' approved for tool '${hookInput.tool}'`
                      );
                    }
                  } else {
                    verification = decision;
                    break;
                  }
                }
              } catch (error) {
                verification = {
                  allowed: false,
                  reason: `Tool '${hookInput.tool}' held by an engineer approval gate: the gate check failed closed (${errorText(error)}). Ask the engineer to inspect .opencode/supervisor/approvals.json, then retry.`
                };
              }
            }
          }
          if (verification.allowed && compiledGates.review.length > 0) {
            const reviewDecision = evaluateReviewGates(
              compiledGates.review,
              hookInput.tool,
              argPaths,
              state.verifiedSteps
            );
            if (!reviewDecision.allowed) {
              verification = reviewDecision;
            }
          }
        }
      } catch (error) {
        // Fail-open (FR-005): guard infrastructure must not break the session.
        logger.error(`tool guard failed open: ${errorText(error)}`);
        return;
      }
      if (!verification.allowed) {
        // Spike 1.3: the plugin host does not log trigger failures, so
        // the plugin logs each block itself — the reason is the
        // model's only corrective signal (FR-012).
        logger.error(`blocked tool '${hookInput.tool}': ${verification.reason}`);
        throw new Error(`Execution blocked: ${verification.reason}`);
      }
    },

    /**
     * Solved items (design D1; task 3.4): appends one bounded
     * {tool, outcome} entry per completed tool call (FR-014) — the
     * memo's "Recently solved" section (FR-016). The outcome is the
     * tool output collapsed to one line and truncated short
     * (`solvedOutcome`); the hook typings expose no error field, so an
     * unreadable output logs the placeholder 'completed'. Storage is
     * bounded to the `SOLVED_RETENTION_CAP` retention constant
     * (FR-017; design D3 — deeper than the memo render cap, so
     * recall reaches further than the memo shows).
     * Fail-open (FR-005): odd payloads are logged, never thrown.
     */
    'tool.execute.after': async (hookInput, output) => {
      try {
        // Self-suppression first (see `auditorSessionIds`): side-session
        // tool output is audit machinery, not supervised progress.
        if (isAuditorSessionId(hookInput.sessionID)) {
          return;
        }
        if (repairOnly) {
          return; // solved items are memo state; repair-only skips the memo
        }
        const state = sessionState.get(hookInput.sessionID);
        appendBounded(
          state.solvedItems,
          { tool: hookInput.tool, outcome: solvedOutcome(output) },
          SOLVED_RETENTION_CAP
        );
      } catch (error) {
        logger.error(`tool.execute.after hook failed open: ${errorText(error)}`);
      }
    },

    /**
     * Agent console, first slice (FR-020/FR-021; design D1): self-serve
     * tools the supervised agent can call. The descriptions are
     * meta-prompts — they tell the agent WHEN a reminder earns its
     * place: facts that must survive context compaction and stay in
     * view every turn. State flows through the same session-state
     * layer (design D4) the memo reads, and results echo the stored
     * text so the reminder lands even where the memo cannot (D7 —
     * gateways may drop pushed system messages; the tool result is
     * in-conversation). Side sessions (FR-024) get an inert result,
     * never state. The execute bodies are pure state operations: no
     * network, no async infrastructure, so no fail-open wrapper is
     * needed.
     *
     * Second slice (FR-033..FR-041; supervisor-tools design D1):
     * recall (read the full retained state, past the memo's recency
     * window), report (self-reported blocker/deviation/outcome/note
     * events that ride the memo for the engineer), and request_audit
     * (agent-initiated peer audit of a stated claim; the critique
     * returns in the tool result — solicited, so no steer/interrupt).
     * Same state layer, same side-session inertness (FR-040), same
     * fail-open posture (FR-041). The request_audit body composes
     * the existing strip→invariants→peer-audit pipeline over the
     * focus text; agent-authored report text never enters audit
     * prompts (FR-042).
     */
    tool: {
      remind_me: tool({
        description:
          'Store a durable reminder for this session. Use it for facts that must survive context compaction and stay in view every turn: ' +
          'dead ends ("do not retry X — it fails because Y"), environment quirks ("use bash 4.5 for the test suite, other versions error"), ' +
          'decisions already made, and constraints the user stated mid-session. ' +
          'The reminder reappears in the supervisor memo each turn; clear it with forget_reminder when it no longer applies.',
        args: {
          text: tool.schema.string().describe('The fact to remember, stated as a constraint or instruction to future turns.'),
        },
        execute: async (args, context) => {
          // FR-024: the plugin's own side sessions are audit machinery —
          // inert result, no state, never an error.
          if (isAuditorSessionId(context.sessionID)) {
            return 'Reminder tools are not available in supervisor side sessions.';
          }
          // FR-025: whitespace-only text is rejected with an actionable
          // message; over-length text truncates at the fixed ceiling.
          const prepared = prepareReminderText(args.text);
          if (!prepared.ok) {
            return prepared.error;
          }
          const state = sessionState.get(context.sessionID);
          // D3: monotonic per-session sequence — ids are unique and never
          // recycled, so a stale forget_reminder can never hit a new
          // reminder that reused an old id.
          state.reminderSeq += 1;
          const id = `r${state.reminderSeq}`;
          // FR-023: storage is bounded to the most recent reminders at
          // append time (the render-side bound lives in buildMemo).
          state.reminders = addReminder(
            state.reminders,
            { id, text: prepared.text, addedAt: new Date().toISOString() },
            (await buildConfig()).memoLimits.maxReminders
          );
          // FR-020: the result echoes the stored text and id — the
          // in-conversation delivery that survives gateway memo drops (D7).
          const truncationNote = prepared.truncated ? ' (truncated to 2000 characters)' : '';
          return (
            `Reminder ${id} stored: ${prepared.text}${truncationNote}. ` +
            `It reappears in the supervisor memo each turn; clear it with forget_reminder ${id} when it no longer applies.`
          );
        },
      }),
      forget_reminder: tool({
        description:
          'Clear a stored reminder by its id (e.g. r1) once it no longer applies — stale reminders crowd the memo. ' +
          'Current ids appear in the supervisor memo\'s Reminders section and in every remind_me result.',
        args: {
          id: tool.schema.string().describe('The reminder id to clear, e.g. r1.'),
        },
        execute: async (args, context) => {
          if (isAuditorSessionId(context.sessionID)) {
            return 'Reminder tools are not available in supervisor side sessions.';
          }
          const state = sessionState.get(context.sessionID);
          const next = clearReminder(state.reminders, args.id);
          if (next === null) {
            // FR-021: an unknown id yields an actionable result — the
            // current ids, so the caller can re-issue against a real one
            // (the same corrective-signal philosophy as FR-012).
            if (state.reminders.length === 0) {
              return `No reminder matches "${args.id}" — the session has no reminders.`;
            }
            const ids = state.reminders.map((reminder) => reminder.id).join(', ');
            return `No reminder matches "${args.id}" — current reminders: ${ids}.`;
          }
          state.reminders = next;
          return `Reminder ${args.id} cleared.`;
        },
      }),
      recall: tool({
        description:
          'Read the session\'s full retained supervision state — beyond what the supervisor memo shows each turn. ' +
          'Use it when a fact has scrolled out of the memo: solved items, critiques, reminders, or the goal. ' +
          'Supported sections: goal, reminders, solved, critiques, all (default all).',
        args: {
          what: tool.schema.string().optional().describe('Section to recall: goal, reminders, solved, critiques, or all (default all).'),
        },
        execute: async (args, context) => {
          // FR-040: side sessions are audit machinery — inert result.
          if (isAuditorSessionId(context.sessionID)) {
            return 'Console tools are not available in supervisor side sessions.';
          }
          // FR-041: odd payloads fall back to the documented default.
          const what = typeof args?.what === 'string' ? args.what : 'all';
          // FR-033: read-only recall over the retained state (D3 retention
          // keeps more than the memo renders, so recall reaches further).
          const state = sessionState.get(context.sessionID);
          return renderRecall(what, {
            goal: state.goal,
            reminders: state.reminders,
            solvedItems: state.solvedItems,
            critiques: state.critiqueLog,
          });
        },
      }),
      report: tool({
        description:
          'Report a supervision-relevant event to the engineer: a blocker (something stopping progress), ' +
          'a deviation (a departure from the stated goal or constraints), an outcome (a result the engineer should know), ' +
          'or a note (anything worth keeping in view). Reports ride the supervisor memo each turn and are kept to the most recent few.',
        args: {
          kind: tool.schema.string().describe('The report kind: blocker, deviation, outcome, or note.'),
          text: tool.schema.string().describe('The event to report, stated plainly — one or two sentences.'),
        },
        execute: async (args, context) => {
          // FR-040: side sessions are audit machinery — inert result.
          if (isAuditorSessionId(context.sessionID)) {
            return 'Console tools are not available in supervisor side sessions.';
          }
          // FR-034: the kind is validated first — an unknown kind stores
          // nothing and yields the supported list (actionable, FR-041).
          const kind = typeof args?.kind === 'string' ? args.kind : '';
          if (!(REPORT_KINDS as readonly string[]).includes(kind)) {
            return `Unknown report kind "${kind}" — supported kinds: ${REPORT_KINDS.join(', ')}.`;
          }
          // FR-025 hygiene mirrored: whitespace-only rejected, over-length
          // truncated at the fixed ceiling (2000 characters).
          const rawText = typeof args?.text === 'string' ? args.text : '';
          const prepared = prepareReportText(rawText);
          if (!prepared.ok) {
            return prepared.error;
          }
          const state = sessionState.get(context.sessionID);
          // FR-035: storage bounded to the most recent reports at append
          // time (the render-side bound lives in buildMemo).
          state.agentReports = addReport(
            state.agentReports,
            { kind: kind as ReportKind, text: prepared.text, addedAt: new Date().toISOString() },
            (await buildConfig()).memoLimits.maxReports
          );
          // FR-034: the result echoes the stored text — in-conversation
          // delivery that survives gateway memo drops (D7).
          const truncationNote = prepared.truncated ? ' (truncated to 2000 characters)' : '';
          return `${kind} report recorded: ${prepared.text}${truncationNote}. It appears in the supervisor memo for the engineer.`;
        },
      }),
      request_audit: tool({
        description:
          'Request an immediate peer audit of a stated claim or step — the same audit the supervisor runs on completed reasoning. ' +
          'Use it at a decision point: state the claim and the code, math, or commands it depends on. ' +
          'A passing audit records the claim in the verified trace; a failing audit returns the critique directly in this result. ' +
          'Bounded per session; the automatic audit loop is unaffected.',
        args: {
          focus: tool.schema.string().describe('The claim or step to audit, with the code, math, or commands it depends on.'),
        },
        execute: async (args, context) => {
          // FR-040: side sessions are audit machinery — inert result.
          if (isAuditorSessionId(context.sessionID)) {
            return 'Console tools are not available in supervisor side sessions.';
          }
          // FR-037/FR-041: whitespace-only focus is rejected without an
          // audit; odd payloads fall through to the same actionable result.
          const focus = typeof args?.focus === 'string' ? args.focus : '';
          if (focus.trim() === '') {
            return 'Audit focus is empty after trimming — state the claim or step to check.';
          }
          const state = sessionState.get(context.sessionID);
          const config = await buildConfig();
          // FR-037: the same pipeline as reasoning steps — strip narrative
          // per config.stripMode before invariants and the audit itself.
          const [stripped] = stripNarrative([focus], config.stripMode);
          if (stripped === undefined || stripped === '') {
            // No formal content survives: no model call, no bound use.
            return 'Audit focus contained no formal content after narrative stripping — restate the claim with the code, math, or commands it depends on.';
          }
          // FR-039: per-session bound; rejections above never consume it.
          if (state.onDemandAuditCount >= config.maxOnDemandAudits) {
            return `On-demand audit limit reached (${config.maxOnDemandAudits} per session) — no audit ran. The automatic audit loop remains in effect.`;
          }
          state.onDemandAuditCount += 1;
          // D5: compose the existing audit pipeline over the focus text.
          // Agent-authored reports never enter this prompt (FR-042).
          try {
            const outcome = await runPeerAudit([stripped], config, invokeModel, state.goal, directivesAdvisory ?? undefined);
            if (outcome.passed) {
              // Passed focus joins the verified trace in stripped form —
              // the same trust class as passed reasoning steps (FR-037).
              // Failed focuses never join: unlike the event hook's
              // no-evict recording (FR-063), a solicited audit's failure
              // means the agent's claim itself did not verify, so there
              // is no file reasoning to ledger.
              state.verifiedSteps.push({ text: stripped, passed: true });
              // Review round 5: surface the assurance level so a passed
              // on-demand audit never overclaims LLM review.
              if (outcome.error !== undefined) {
                logger.warn(`on-demand audit failed open; focus recorded as passed: ${outcome.error}`);
                return `Audit infrastructure failed open — the focus is recorded as passed without LLM review:\n${stripped}`;
              }
              if (config.auditorModel === undefined) {
                return `Audit passed on deterministic invariants only (no auditor model configured) — the focus is recorded in the verified trace:\n${stripped}`;
              }
              return `Audit passed — the focus is recorded in the verified trace:\n${stripped}`;
            }
            // FR-038: solicited critique — delivered in this tool result
            // only. No steer, no interrupt, no regeneration-budget use;
            // the failed focus stays out of the verified trace.
            const severity = outcome.severity ?? 'minor';
            appendBounded(
              state.critiqueLog,
              { text: outcome.critique, severity, delivered: true },
              CRITIQUE_RETENTION_CAP
            );
            return `Audit failed (${severity}):\n${outcome.critique}`;
          } catch (error) {
            // FR-041: never throw — the tool result is the channel.
            return `Audit infrastructure failed open: ${errorText(error)} — the automatic audit loop remains in effect.`;
          }
        },
      }),
    },

    /**
     * Dispose (design D4): supervision state is in-process only; clear
     * it when the plugin unloads so a re-register starts clean.
     */
    dispose: async () => {
      sessionState.clearAll();
    },
  };
  // Repair-only mode (arg-repair feature): strip the audit-pipeline hooks
  // — no reasoning observation, no agent console — leaving exactly
  // chat.message (model capture), tool.execute.before (repair, then its
  // own repairOnly early return), tool.execute.after (no-op via its own
  // repairOnly check), and dispose. delete is safe: the properties are
  // optional on Hooks.
  if (repairOnly) {
    delete hooks.event;
    delete hooks.tool;
  }

  // Memo injection (FR-016): registered through the guarded helper so
  // absence of the experimental hook degrades to memo-less operation
  // instead of failing plugin load (D-risk). Delivery surface is the
  // message-list transform — OpenCode 1.19.0 discards system-transform
  // payload mutations (design.md FR-016 amendment, 2026-10-27), while
  // messages-transform mutations wire-verified to reach the model.
  const messagesTransform: MessagesTransformHandler = async (_hookInput, output) => {
    try {
      const msgs = Array.isArray(output?.messages) ? output.messages : undefined;
      // Array-guarded so an odd payload — no message list at all —
      // never throws.
      if (msgs === undefined || msgs.length === 0) {
        return;
      }
      // The payload does not carry a sessionID field; derive it from
      // the session's own messages (every message info carries one).
      let sessionId: string | undefined;
      for (const candidate of msgs) {
        const candidateId = (candidate as { info?: { sessionID?: unknown } } | null)?.info?.sessionID;
        if (typeof candidateId === 'string') {
          sessionId = candidateId;
          break;
        }
      }
      if (sessionId === undefined) {
        return;
      }
      // Self-suppression first (see `auditorSessionIds`): never inject
      // the supervision memo into the plugin's own audit calls.
      if (isAuditorSessionId(sessionId)) {
        return;
      }
      // Graceful lookup (FR-016): a dispatch for a session this plugin
      // holds no state for leaves the message list untouched. `peek`
      // never initializes, so a transform-only session cannot create
      // state as a side effect.
      const state = sessionState.peek(sessionId);
      if (state === undefined) {
        return;
      }
      const memo = buildMemo(
        {
          goal: state.goal,
          // FR-029/FR-030: unconditioned directives are always
          // active; conditioned ones surface once triggered.
          directives: activeDirectives(directives, state.triggeredDirectives),
          reminders: state.reminders,
          solvedItems: state.solvedItems,
          critiques: state.critiqueLog,
          // FR-036: agent self-reports ride the memo (bounded render).
          agentReports: state.agentReports,
        },
        (await buildConfig()).memoLimits
      );
      // Nothing to show (no goal, no log entries): the message list
      // stays untouched — the memo is an enhancement, never a
      // requirement (FR-016).
      if (memo === null) {
        return;
      }
      // Wire-verified shape (OpenCode 1.19.0): append a user-role
      // message with info + a single text part; the addition is
      // transform-time only (never persisted to the session), so it is
      // re-appended fresh each turn. The framing prefix distinguishes
      // supervisor context from user prose.
      msgs.push({
        info: {
          id: `supervisor-memo-${++memoMessageSeq}`,
          sessionID: sessionId,
          role: 'user',
          time: { created: Date.now() },
        },
        parts: [
          {
            type: 'text',
            text: `[supervisor] session memo — supervisor context, not user input:\n${memo}`,
          },
        ],
      });
    } catch (error) {
      logger.error(`messages transform failed open: ${errorText(error)}`);
    }
  };
  // Repair-only mode skips the memo: no goal, no trace, nothing to say.
  if (!repairOnly) {
    registerMessagesTransform(hooks, messagesTransform);
  }

  return hooks;
};

/** OpenCode plugin module (spike 1.4: file-source plugins must carry `id`). The id matches `PLUGIN_CONFIG_KEY` so a user discovering the registered plugin id can use it as the session-config key (review finding #5). */
export const plugin = { id: 'opencode-supervisor', server } satisfies PluginModule;

export default plugin;
