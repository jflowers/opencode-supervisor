/**
 * Text Tool-Call Recovery
 * Detects a turn that ended with a tool call written into the reply as
 * plain text instead of made (FR-090), and words the correction the
 * supervisor steers the session with (FR-091). Some models (GLM 5.3 on
 * EnMaaS so far) emit `<invoke name="question">…</invoke>` as text: no
 * tool call happens, `tool.execute.before` never fires, and the run
 * looks finished. Detection is gated on a registered tool id and
 * ignores code (fenced blocks and inline spans), so prose about tool
 * calls never matches. Subagents are corrected at their parent's
 * `task` boundary (FR-096..FR-098), so this module also reads and
 * rewrites the task tool's result frame. Pure: no OpenCode imports,
 * no I/O — the hook
 * wiring lives in `index.ts`.
 */

/** Default `textToolCall` configuration (FR-094). */
export interface TextToolCallConfig {
  /** Whether the idle check runs at all. */
  enabled: boolean;
  /** Corrections allowed in a row per session before the session is left idle (FR-092). */
  maxPerSession: number;
}

export const DEFAULT_TEXT_TOOL_CALL: TextToolCallConfig = { enabled: true, maxPerSession: 2 };

/** The textual shapes recognized as a tool call (FR-090). */
export type TextToolCallShape = 'invoke' | 'function_calls' | 'tool_call' | 'json';

/** One detected text tool call: the registered tool it names and its shape. */
export interface TextToolCall {
  tool: string;
  shape: TextToolCallShape;
}

/**
 * Structural message shape (a subset of the SDK's session message):
 * kept local so this module stays free of OpenCode imports.
 */
export interface TurnMessage {
  info: { id?: string; role?: string; error?: unknown };
  parts: Array<{ type?: string; text?: string } | null | undefined>;
}

/** Outcome of checking the last turn: which message, and what was found. */
export interface TurnAssessment {
  /** The checked assistant message's id, for duplicate-idle dedupe (FR-093). */
  messageID: string | undefined;
  /** The detected text tool call, or null when the turn ended cleanly. */
  detection: TextToolCall | null;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Blanks out code so it cannot match (FR-090): fenced blocks (``` or
 * ~~~, closed by a fence of the same character at least as long, or
 * running to the end of the text) and inline backtick spans. Line
 * breaks survive, so the remaining prose keeps its shape.
 *
 * @param text The message text.
 * @returns The text with code replaced by spaces.
 */
export function maskCode(text: string): string {
  const lines = text.split('\n');
  let open: string | null = null;
  const kept = lines.map((line) => {
    const fence = FENCE.exec(line)?.[1];
    if (open === null) {
      if (fence !== undefined) {
        open = fence;
        return '';
      }
      return line;
    }
    if (fence !== undefined && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) {
      open = null;
    }
    return '';
  });
  return kept.join('\n').replace(/``[^`]*``|`[^`\n]*`/g, (span) => ' '.repeat(span.length));
}

const INVOKE = /<(?:[A-Za-z_][\w-]*:)?invoke\s+name\s*=\s*["']([^"'<>\s]+)["']/g;
const FUNCTION_CALLS = /<(?:[A-Za-z_][\w-]*:)?function_calls\s*>/;
const TOOL_CALL = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g;
const TOOL_CALL_JSON_NAME = /^\{\s*"name"\s*:\s*"([^"]+)"/;
const TOOL_CALL_BARE_NAME = /^([A-Za-z_][\w.-]*)/;
const JSON_CALL = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:/g;

/**
 * Detects text shaped like a tool call that names a registered tool
 * (FR-090). Shapes, first registered match wins: `<invoke name="x">`
 * (optionally namespaced; reported as `function_calls` when inside
 * that wrapper), `<tool_call>` with a JSON object carrying `"name"` or
 * a leading bare tool name (the GLM template), and a bare
 * `{"name": "x", "arguments": …}` object. Code is masked first.
 *
 * @param text The assistant message text.
 * @param toolIds Registered tool ids (case-sensitive).
 * @returns The detected call, or null.
 */
export function detectTextToolCall(text: string, toolIds: ReadonlySet<string>): TextToolCall | null {
  if (text === '' || toolIds.size === 0) {
    return null;
  }
  const prose = maskCode(text);
  for (const match of prose.matchAll(INVOKE)) {
    const tool = match[1];
    if (tool !== undefined && toolIds.has(tool)) {
      const before = prose.slice(0, match.index);
      return { tool, shape: FUNCTION_CALLS.test(before) ? 'function_calls' : 'invoke' };
    }
  }
  for (const match of prose.matchAll(TOOL_CALL)) {
    const body = (match[1] ?? '').trim();
    const tool = (body.startsWith('{') ? TOOL_CALL_JSON_NAME : TOOL_CALL_BARE_NAME).exec(body)?.[1];
    if (tool !== undefined && toolIds.has(tool)) {
      return { tool, shape: 'tool_call' };
    }
  }
  for (const match of prose.matchAll(JSON_CALL)) {
    const tool = match[1];
    if (tool !== undefined && toolIds.has(tool)) {
      return { tool, shape: 'json' };
    }
  }
  return null;
}

/**
 * Assesses the session's last turn (FR-090, design D2). Only the last
 * message counts, and only an assistant message without an error (an
 * aborted or failed turn is not resumed). Its last text part is
 * checked; a tool part after that text means a real call happened.
 *
 * @param messages The session's messages, oldest first.
 * @param toolIds Registered tool ids.
 * @returns The assessment, or null when there is nothing to check.
 */
export function assessLastTurn(messages: readonly TurnMessage[], toolIds: ReadonlySet<string>): TurnAssessment | null {
  const last = messages[messages.length - 1];
  if (last === undefined || last.info?.role !== 'assistant') {
    return null;
  }
  if (last.info.error !== undefined && last.info.error !== null) {
    return null;
  }
  const messageID = typeof last.info.id === 'string' ? last.info.id : undefined;
  const parts = Array.isArray(last.parts) ? last.parts : [];
  let textIndex = -1;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
      textIndex = index;
      break;
    }
  }
  if (textIndex === -1) {
    return null;
  }
  if (parts.slice(textIndex + 1).some((part) => part?.type === 'tool')) {
    return { messageID, detection: null };
  }
  const text = parts[textIndex]?.text ?? '';
  return { messageID, detection: detectTextToolCall(text, toolIds) };
}

/**
 * The correction steered into the session (FR-091): names the tool,
 * asks for the real call, and asks not to repeat the text.
 *
 * @param call The detected text tool call.
 * @returns The synthetic message text.
 */
export function textToolCallMessage(call: TextToolCall): string {
  return (
    `[supervisor] Your last message wrote a \`${call.tool}\` tool call as text, so it never ran. ` +
    "Make the actual tool call now; don't repeat the text."
  );
}

const COMPLETED_TASK = /^<task id="[^"]*" state="completed">\n/;
const TASK_RESULT_OPEN = '<task_result>\n';
const TASK_RESULT_CLOSE = '\n</task_result>';

/**
 * Locates the result body of a completed `task` tool output (FR-097,
 * design D3): the text between the frame's `<task_result>` and its
 * closing tag. The body may itself contain the tag text, so the first
 * opening and the last closing tag delimit it.
 *
 * @param output The `task` tool's output string.
 * @returns The body's bounds, or null when the output is not a
 *   completed task result (fail open: the caller skips).
 */
function taskResultBounds(output: string): { start: number; end: number } | null {
  if (!COMPLETED_TASK.test(output)) {
    return null;
  }
  const open = output.indexOf(TASK_RESULT_OPEN);
  const end = output.lastIndexOf(TASK_RESULT_CLOSE);
  if (open === -1 || end < open + TASK_RESULT_OPEN.length) {
    return null;
  }
  return { start: open + TASK_RESULT_OPEN.length, end };
}

/**
 * Reads the subagent's final text from a completed `task` output
 * (FR-096/FR-098).
 *
 * @param output The `task` tool's output string.
 * @returns The result body, or null when the output is not a
 *   completed task result.
 */
export function parseTaskResult(output: string): string | null {
  const bounds = taskResultBounds(output);
  return bounds === null ? null : output.slice(bounds.start, bounds.end);
}

/**
 * Replaces the result body of a completed `task` output, keeping the
 * frame and task id (FR-097).
 *
 * @param output The `task` tool's output string.
 * @param text The new result body.
 * @returns The rewritten output, or null when the output is not a
 *   completed task result.
 */
export function replaceTaskResult(output: string, text: string): string | null {
  const bounds = taskResultBounds(output);
  return bounds === null ? null : output.slice(0, bounds.start) + text + output.slice(bounds.end);
}

/**
 * The text OpenCode's task tool would return for a message: its last
 * text part, or '' (design D2).
 *
 * @param parts The message parts.
 * @returns The last text part's text.
 */
export function lastTextOf(parts: TurnMessage['parts'] | undefined): string {
  if (!Array.isArray(parts)) {
    return '';
  }
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part?.type === 'text') {
      return typeof part.text === 'string' ? part.text : '';
    }
  }
  return '';
}

/**
 * The note appended to a parent's task result when the subagent
 * still ends with a text tool call (FR-097): the parent learns the
 * call never ran instead of taking the text as finished work.
 *
 * @param call The text tool call left in the subagent's reply.
 * @returns The note text.
 */
export function subagentTextToolCallNote(call: TextToolCall): string {
  return (
    `[supervisor] The subagent's final reply wrote a \`${call.tool}\` tool call as text, so it never ran. ` +
    'This result is incomplete.'
  );
}
