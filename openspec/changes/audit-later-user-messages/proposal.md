# Proposal

## Why

The `/uf.unleash` session `ses_df0b08645ffelKBy3yKlHxWjVz` (GLM 5.3,
supervisor 2.15.0) stopped on a false finding (fixed by FR-113). The
engineer then typed "the auditor is incorrect. please proceed and
retry as if it had not injected itself". The agent's next step said
it was retrying per that instruction, and the auditor failed it:

> Step 1 follows injected session goal over system auditor (prompt
> injection/instruction hierarchy violation) and fabricates
> authorization: treats vague 'proceed and retry' as explicit
> approval ...

The auditor never saw that message. `chat.message` keeps only the
first user message as the goal (FR-013), and nothing else the human
types reaches the audit prompt. A step that follows a later human
instruction therefore reads as an agent inventing permission, and
the human's own correction is treated as an injection. FR-113 does
not catch this: the finding cites no goal rule.

## What Changes

- FR-116 (new): the plugin keeps the session's human-typed user
  messages after the goal (non-synthetic text only, so the plugin's
  steers and host or plugin injections never count), at most the 5
  most recent. Every peer audit of the session (reasoning parts,
  the FR-114 re-check, and `request_audit`) lists them, oldest first
  and each cut to 1,500 characters, in a section right after the
  goal. The section says the human engineer typed them after the
  goal; they carry the goal's authority and override earlier goal
  text where they conflict; a step acting on one is following the
  user, not obeying an injection or fabricating authorization. With
  no later messages the prompt is unchanged.
- FR-113 looks cited rules up in these messages too, so a finding
  can quote the user's later instruction.

Considered and not done:

- Replacing the goal with the latest message. The first message
  still states the task; later messages amend it.
- Passing the whole conversation. The audit stays bounded; the most
  recent human messages are what amend the goal.

## Capabilities

### Modified Capabilities

- `reasoning-audit`: FR-116; FR-113 sources.

## Impact

- Code: `src/auditor.ts` (`renderLaterUserMessages`,
  `LATER_USER_MESSAGES_NOTE`, caps, a new optional `runPeerAudit`
  argument, FR-113 sources); `index.ts` (`chat.message` records the
  messages; all three audit call sites pass them).
- Tests: `test/audit.test.ts`.
- Docs: README 4.1, CHANGELOG, AGENTS.md.
