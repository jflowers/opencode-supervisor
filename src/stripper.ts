/**
 * Narrative Stripper for Process Supervision
 * Isolates formal code blocks, mathematical equations, and state invariants
 * from verbose Chain-of-Thought narrative text. Since FR-068 (design D9),
 * path-bearing steps survive `code_and_math` and `balanced` too — a step
 * naming `notes.md` in plain prose must reach the audit and the verified
 * trace, or the tool guard's corrective loop cannot close (the shared
 * `path-tokens.ts` grammar decides what counts). `strict` is unchanged:
 * zero natural language is its contract.
 */
export type StripMode = 'code_and_math' | 'balanced' | 'strict';

import { hasPathToken } from './path-tokens.ts';

const NARRATIVE_PREFIX_REGEX = /^(?:(?:let's|let us|i will|i'll|now let's|first,|second,|third,|next,|finally,|hmm,|wait,|okay,|sure,|to solve this,|thinking about this,)\s+)+/i;

export function stripNarrative(
  rawSteps: string[],
  mode: StripMode = 'code_and_math'
): string[] {
  return rawSteps
    .map((step) => step.trim())
    .filter((step) => {
      const hasCode = step.includes('```') || /`[^`]+`/.test(step);
      const hasMathOrOps = /[\+\-\*\/=<>]|!==|===|<=|>=|\b(?:assert|return|throw|SELECT|UPDATE|DELETE|function)\b|\b(?:const|let)\s+[a-zA-Z_$]\w*\s*=/.test(step);
      const hasFormalSpec = /\b(?:O\([^)]+\)|step\s*\d+|invariant|precondition|postcondition|complexity|path|file)\b/i.test(step);
      // FR-068 (design D9): a path-like token is formal content —
      // survival here is what lets a corrective re-statement reach the
      // audit and the trace. Narrative-prefix removal still applies.
      const hasPath = hasPathToken(step);

      if (mode === 'strict') {
        return step.includes('```') || /[0-9]+\s*[\+\-\*\/=]\s*[0-9]+|[a-zA-Z_]\w*\s*=\s*[^=]/.test(step);
      }
      if (mode === 'balanced') {
        return hasCode || hasMathOrOps || hasFormalSpec || hasPath;
      }
      return hasCode || hasMathOrOps || hasPath;
    })
    .map((step) =>
      step
        .replace(NARRATIVE_PREFIX_REGEX, '')
        .replace(/\b(?:I think that|It seems like|Basically,|Obviously,|Clearly,)\s*/gi, '')
        .trim()
    );
}
