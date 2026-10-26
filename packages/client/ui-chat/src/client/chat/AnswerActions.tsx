// Tracy (tracy.42): the assistant reply's action row for answers that are not
// an agent turn: a settled slash command, and a client-local answer row
// (`ctx.chatLocal.AnswerActions`). Same chrome as the turn tail: copy, the
// optional Like/Dislike pair, branch, then the clock.

import { memo, useCallback } from 'react'
import {
  IconDislikeFillRegular, IconDislikeOutlineRegular, IconLikeFillRegular, IconLikeOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { AnswerFeedback } from '../contract/chat-local.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './AnswerActions.module.css'

export interface AnswerActionsRowProps {
  /** Plain text the copy action writes. */
  readonly text: string
  /** Unix epoch ms of the answer for the clock; omitted shows no clock. */
  readonly time?: number | undefined
  /** Branch the session here; omission hides the branch action. */
  readonly onBranch?: (() => void) | undefined
  /** Branch stays visible but unavailable. */
  readonly branchUnavailable?: boolean | undefined
  /** The answer's own rating; omission draws no Like/Dislike. */
  readonly feedback?: AnswerFeedback | undefined
  /** The `chat` namespace translator (copy, branch, clock). */
  readonly t: ChatViewSlotProps['t']
}

/**
 * Like/Dislike of an answer the caller rates itself: the agent row's glyphs
 * and resting/hover chrome, a recorded rating filled and pressed. A press on
 * the recorded rating asks the caller to retract it.
 */
const AnswerFeedbackActions = memo(function AnswerFeedbackActions({ feedback }: { feedback: AnswerFeedback }) {
  const { rating, rate, pending, labels } = feedback
  const onLike = useCallback(() => { rate('positive') }, [rate])
  const onDislike = useCallback(() => { rate('negative') }, [rate])
  const likeLabel = rating === 'positive' ? labels.likeActive : labels.like
  const dislikeLabel = rating === 'negative' ? labels.dislikeActive : labels.dislike
  return (
    <>
      <Tooltip label={likeLabel} side="bottom">
        <button
          type="button"
          className={css.feedback}
          aria-label={likeLabel}
          aria-pressed={rating === 'positive'}
          data-active={rating === 'positive' || undefined}
          disabled={pending === true}
          onClick={onLike}
        >
          {rating === 'positive' ? <IconLikeFillRegular /> : <IconLikeOutlineRegular />}
        </button>
      </Tooltip>
      <Tooltip label={dislikeLabel} side="bottom">
        <button
          type="button"
          className={css.feedback}
          aria-label={dislikeLabel}
          aria-pressed={rating === 'negative'}
          data-active={rating === 'negative' || undefined}
          disabled={pending === true}
          onClick={onDislike}
        >
          {rating === 'negative' ? <IconDislikeFillRegular /> : <IconDislikeOutlineRegular />}
        </button>
      </Tooltip>
    </>
  )
})

/**
 * One answer's action row. It claims the always-visible seat
 * (`data-actions-reveal="always"`); the stylesheet takes that seat back to the
 * hover reveal once a later exchange follows it, or while the composer holds a
 * draft (MessageIconActions.module.css), the same as a turn tail.
 * @param props - Copy text, time, branch, feedback, translator.
 * @returns the row.
 */
export const AnswerActionsRow = memo(function AnswerActionsRow({
  text, time, onBranch, branchUnavailable, feedback, t,
}: AnswerActionsRowProps) {
  return (
    <div className={css.root} data-actions-reveal="always" data-answer-actions="">
      <MessageIconActions
        text={text}
        time={time}
        clock="end"
        onBranch={onBranch}
        branchUnavailable={branchUnavailable}
        className={css.actions}
        extraActions={feedback === undefined ? null : <AnswerFeedbackActions feedback={feedback} />}
        t={t}
      />
    </div>
  )
})
