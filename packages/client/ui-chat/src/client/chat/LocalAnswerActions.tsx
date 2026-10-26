// Tracy (tracy.42): `ctx.chatLocal.AnswerActions`, the agent reply's action
// row as a component a plugin draws under its own client-local answer. A
// plugin's renderer is not handed the `chat` translator nor `forkAt` outside
// the transcript (Tracy's Help also draws its rows above the composer of a
// blank session), so the component carries both.

import { memo, useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LocalAnswerActionsProps } from '../contract/chat-local.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { AnswerActionsRow } from './AnswerActions.tsx'

/** What the bound row needs from the apply world. */
export interface LocalAnswerActionsDeps {
  /** The `chat` namespace translator. */
  readonly t: ChatViewSlotProps['t']
  /** The locale service: a language switch redraws the row. */
  readonly locale: {
    subscribe(listener: () => void): () => void
    getSnapshot(): unknown
  }
  /** Fork the session at one durable seq and open the child. */
  readonly forkAt: (sessionId: SessionId, seq: number) => void
}

/**
 * The durable event a branch of a local answer cuts at, or undefined when
 * there is none: `tailSeq()` may be fractional (synthetic chat nodes sit
 * between durable seqs) and is -1 for a session without a log.
 * @param seq - the answer's anchor.
 * @returns the inclusive cut, or undefined.
 */
export function branchSeqOf(seq: number | undefined): number | undefined {
  if (seq === undefined || !Number.isFinite(seq)) return undefined
  const cut = Math.floor(seq)
  return cut >= 0 ? cut : undefined
}

/**
 * @param deps - translator, locale source and session fork.
 * @returns the component `ctx.chatLocal.AnswerActions` hands to plugins.
 */
export function bindLocalAnswerActions(deps: LocalAnswerActionsDeps): ComponentType<LocalAnswerActionsProps> {
  const subscribe = (listener: () => void) => deps.locale.subscribe(listener)
  const snapshot = () => deps.locale.getSnapshot()
  return memo(function LocalAnswerActions({ sessionId, text, time, branchAt, feedback }: LocalAnswerActionsProps) {
    const revision = useSyncExternalStore(subscribe, snapshot)
    // A new translator identity per language snapshot: the memoised row below
    // would otherwise keep the words it drew first.
    const t = useMemo<ChatViewSlotProps['t']>(
      () => ((...args: Parameters<ChatViewSlotProps['t']>) => deps.t(...args)) as ChatViewSlotProps['t'],
      [revision],
    )
    const cut = branchSeqOf(branchAt)
    return (
      <AnswerActionsRow
        text={text}
        time={time}
        onBranch={cut === undefined ? undefined : () => { deps.forkAt(sessionId, cut) }}
        feedback={feedback}
        t={t}
      />
    )
  })
}
