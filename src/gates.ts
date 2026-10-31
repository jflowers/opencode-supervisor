/**
 * Approve-gate and review-gate evaluation for the engineer
 * console (FR-043 .. FR-048). Pure module: compilation of the
 * approve/review rule kinds declared in `src/directives.ts`,
 * gate matching against tool calls, approval-record parsing
 * and matching, and the fail-closed verification decisions.
 * Filesystem access (reading `.opencode/supervisor/
 * approvals.json` fresh per gated call) stays in `index.ts`;
 * this module only turns raw file text and rule tables into
 * decisions.
 */

import type { VerifiedTraceEntry } from './auditor.ts';
import { globToRegExp, type Directive } from './directives.ts';

/**
 * Fixed cap on the approval records kept from the approvals
 * file (FR-044): the most recent entries survive.
 */
export const MAX_APPROVALS = 50;

/**
 * Fixed upper bound on the approvals file size read per gated
 * call (FR-045): a larger file fails closed with an error
 * instead of stalling the event loop on a planted file.
 */
export const MAX_APPROVALS_FILE_BYTES = 64 * 1024;

/** One engineer-recorded approval (FR-044). */
export interface ApprovalRecord {
  /** Gate key this record approves. */
  gate: string;
  /** Optional engineer note, surfaced nowhere else. */
  note?: string;
  /** Optional expiry date, YYYY-MM-DD; past dates never match. */
  expires?: string;
}

/** A compiled `approve` rule ready for matching. */
export interface CompiledApproveGate {
  /** Explicit rule id, else `<directiveId>/<ruleIndex>`. */
  key: string;
  /** Owning directive id. */
  directiveId: string;
  /** Tool name that must match (case-insensitive). */
  tool?: string;
  /** Compiled path glob. */
  pathRegex?: RegExp;
  /** Compiled regex applied to the raw serialized arguments. */
  patternRegex?: RegExp;
}

/** A compiled `review` rule ready for matching. */
export interface CompiledReviewGate {
  /** Owning directive id. */
  directiveId: string;
  /** Original path glob, for messages. */
  pathGlob: string;
  /** Compiled path glob. */
  regex: RegExp;
}

/** The compiled gate tables for a directive set. */
export interface CompiledGates {
  approve: CompiledApproveGate[];
  review: CompiledReviewGate[];
}

/** A matched approve gate, carried into verification. */
export interface ApproveGateMatch {
  key: string;
  directiveId: string;
}

/** Uniform gate decision shape (mirrors ToolVerificationResult). */
export interface GateDecision {
  allowed: boolean;
  reason: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compile the approve and review rule kinds of a directive set
 * (FR-043, FR-047). Gate keys default to `<directiveId>/
 * <ruleIndex>` when the rule carries no explicit id (D3), so
 * the key in a block reason can be copied verbatim into the
 * approvals file. Invalid regex patterns drop just that
 * criterion with a warning; a rule left with no usable
 * criterion is skipped entirely.
 */
export function compileGates(directives: Directive[]): {
  gates: CompiledGates;
  warnings: string[];
} {
  const warnings: string[] = [];
  const approve: CompiledApproveGate[] = [];
  const review: CompiledReviewGate[] = [];
  for (const directive of directives) {
    (directive.approve ?? []).forEach((rule, index) => {
      const key =
        typeof rule.id === 'string' && rule.id.length > 0
          ? rule.id
          : `${directive.id}/${index}`;
      const gate: CompiledApproveGate = { key, directiveId: directive.id };
      if (typeof rule.tool === 'string') gate.tool = rule.tool;
      if (typeof rule.path === 'string') {
        gate.pathRegex = globToRegExp(rule.path);
      }
      let hasCriterion =
        gate.tool !== undefined || gate.pathRegex !== undefined;
      if (typeof rule.pattern === 'string') {
        try {
          gate.patternRegex = new RegExp(rule.pattern, 'i');
          hasCriterion = true;
        } catch (error) {
          warnings.push(
            `directive '${directive.id}': approve pattern '${rule.pattern}' failed to compile (${errorText(error)}); criterion dropped`
          );
        }
      }
      if (!hasCriterion) {
        warnings.push(
          `directive '${directive.id}': approve rule at index ${index} has no usable criterion; rule skipped`
        );
        return;
      }
      approve.push(gate);
    });
    for (const rule of directive.review ?? []) {
      review.push({
        directiveId: directive.id,
        pathGlob: rule.path,
        regex: globToRegExp(rule.path)
      });
    }
  }
  return { gates: { approve, review }, warnings };
}

/**
 * Match a tool call against the compiled approve gates
 * (FR-043). Every criterion present on a gate must hold (AND
 * semantics): tool name compares case-insensitively, the path
 * glob tests full path or basename of some extracted policy
 * path, and the pattern tests the raw serialized arguments.
 * Returns every matching gate so overlapping policy is
 * evaluated in full; an empty array means no gate matched.
 */
export function matchApproveGates(
  gates: CompiledApproveGate[],
  toolName: string,
  rawArgs: string,
  argPaths: string[]
): ApproveGateMatch[] {
  const matches: ApproveGateMatch[] = [];
  for (const gate of gates) {
    if (
      gate.tool !== undefined &&
      gate.tool.toLowerCase() !== toolName.toLowerCase()
    ) {
      continue;
    }
    if (gate.pathRegex !== undefined) {
      const pathMatched = argPaths.some((argPath) => {
        const base =
          argPath.split('/').pop()?.toLowerCase() || argPath.toLowerCase();
        return (
          gate.pathRegex!.test(argPath) || gate.pathRegex!.test(base)
        );
      });
      if (!pathMatched) continue;
    }
    if (gate.patternRegex !== undefined && !gate.patternRegex.test(rawArgs)) {
      continue;
    }
    matches.push({ key: gate.key, directiveId: gate.directiveId });
  }
  return matches;
}

/**
 * Parse the approvals file text (FR-044). Structural failures
 * (invalid JSON, non-array) return an error string for the
 * fail-closed path (FR-045); malformed entries are skipped.
 * The kept record set is bounded to the most recent
 * MAX_APPROVALS entries.
 */
export function parseApprovals(raw: string): {
  records: ApprovalRecord[];
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      records: [],
      error: `approvals file is not valid JSON: ${errorText(error)}`
    };
  }
  if (!Array.isArray(parsed)) {
    return { records: [], error: 'approvals file is not a JSON array' };
  }
  const records: ApprovalRecord[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.gate !== 'string' || record.gate.trim().length === 0) {
      continue;
    }
    const approval: ApprovalRecord = { gate: record.gate.trim() };
    if (typeof record.note === 'string' && record.note.trim().length > 0) {
      approval.note = record.note.trim();
    }
    if (
      typeof record.expires === 'string' &&
      record.expires.trim().length > 0
    ) {
      approval.expires = record.expires.trim();
    }
    records.push(approval);
  }
  return { records: records.slice(-MAX_APPROVALS), error: null };
}

/**
 * Whether a gate key is approved at the given time (FR-044):
 * some record names the key and carries no expiry, or an
 * expiry whose end of day (inclusive) is not past. An
 * unparseable expiry never matches.
 */
export function approvalMatches(
  records: ApprovalRecord[],
  gateKey: string,
  now: Date = new Date()
): boolean {
  return records.some((record) => {
    if (record.gate !== gateKey) return false;
    if (typeof record.expires !== 'string') return true;
    const expiry = Date.parse(`${record.expires}T23:59:59.999Z`);
    if (Number.isNaN(expiry)) return false;
    return now.getTime() <= expiry;
  });
}

/**
 * Verify a matched approve gate against the freshly read
 * approval records (FR-043, FR-045). A read or parse error
 * blocks with the error carried in the reason — the gate
 * fails closed, unlike the load-time fail-open of FR-032.
 * An approved gate proceeds; an unapproved gate blocks with
 * the exact approval instruction.
 */
export function evaluateApproveGate(
  match: ApproveGateMatch,
  toolName: string,
  records: ApprovalRecord[],
  readError: string | null,
  now: Date = new Date()
): GateDecision {
  if (readError !== null) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' held by engineer directive '${match.directiveId}' approval gate '${match.key}': the approvals file could not be read (${readError}); the gate fails closed. Ask the engineer to fix .opencode/supervisor/approvals.json, then retry.`
    };
  }
  if (approvalMatches(records, match.key, now)) {
    return { allowed: true, reason: '' };
  }
  return {
    allowed: false,
    reason: `Tool '${toolName}' held by engineer directive '${match.directiveId}' approval gate '${match.key}': engineer approval required. Ask the engineer to add {"gate": "${match.key}"} to .opencode/supervisor/approvals.json, then retry.`
  };
}

/**
 * Evaluate the review gates for a tool call (FR-047). Every
 * extracted policy path touched by a review glob must be
 * referenced by a passed step in the verified trace (full
 * path or basename, case-insensitive — the same reference
 * semantics as the FR-011 trace check). An empty trace
 * blocks: the gate is explicit engineer policy, and the
 * request_audit tool gives the agent a constructive path to
 * populate the trace. Entries carrying `passed: false`
 * (FR-063 no-evict recording) do not release a gate: only
 * a step the audit passed counts as verified reasoning.
 */
export function evaluateReviewGates(
  gates: CompiledReviewGate[],
  toolName: string,
  argPaths: string[],
  verifiedSteps: VerifiedTraceEntry[]
): GateDecision {
  let combinedSteps: string | null = null;
  for (const gate of gates) {
    for (const argPath of argPaths) {
      const base =
        argPath.split('/').pop()?.toLowerCase() || argPath.toLowerCase();
      const touched = gate.regex.test(argPath) || gate.regex.test(base);
      if (!touched) continue;
      if (combinedSteps === null) {
        combinedSteps = verifiedSteps
          .filter((entry) => entry.passed)
          .map((entry) => entry.text)
          .join(' ')
          .toLowerCase();
      }
      const referenced =
        combinedSteps.includes(base) ||
        combinedSteps.includes(argPath.toLowerCase());
      if (!referenced) {
        return {
          allowed: false,
          reason: `Tool '${toolName}' held by engineer directive '${gate.directiveId}' review gate: path '${argPath}' (glob '${gate.pathGlob}') requires a passed peer audit before it can be touched. Reason about the path in verified steps and pass the audit (the request_audit tool can audit a stated focus immediately), then retry.`
        };
      }
    }
  }
  return { allowed: true, reason: '' };
}
