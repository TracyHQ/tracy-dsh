import { memo, useMemo } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatNodeViewProps, ChatViewSlotProps, CommandRowOwnerProps,
} from '../contract/slots.ts'
import { AnswerActionsRow } from './AnswerActions.tsx'
import { CompactionCommandCard } from './CompactionCommandCard.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'
import css from './ChatView.module.css'

type CommandNodeViewProps = ChatNodeViewProps<'command'> & PropsRenderSlots<'conversation.chat.commandview'>

/**
 * What a settled command's row copies: the text its card shows as the result.
 * @param outcome - the settlement.
 * @param t - the `chat` translator, for a settlement without text.
 * @returns the plain text.
 */
function settledText(outcome: NonNullable<CommandRowOwnerProps['node']['outcome']>, t: ChatViewSlotProps['t']): string {
  return outcome.text ?? (outcome.kind === 'error' ? t('command.failed') : t('command.done'))
}

/** Ordinary command lifecycle renderer with command-name keyed specialization. */
export const CommandNodeView = memo(function CommandNodeView({ node, renderSlot, forkAt, t }: CommandNodeViewProps) {
  const command = node.data
  const owner = useMemo<CommandRowOwnerProps>(() => ({ node: command }), [command])
  const settledSeq = command.settledSeq
  return (
    <div className={css.callRow}>
      {renderSlot('conversation.chat.commandview', owner, {
        entryKey: command.name ?? '',
        fallback: <GenericCommandCard {...owner} t={t} />,
      })}
      {/* Tracy (tracy.42): a settled command ends like an agent reply. It names no
          assistant message, so it carries no Like/Dislike. */}
      {command.outcome !== null && (
        <AnswerActionsRow
          text={settledText(command.outcome, t)}
          time={command.time}
          onBranch={settledSeq === undefined ? undefined : () => { forkAt(settledSeq) }}
          t={t}
        />
      )}
    </div>
  )
})

/** One integrated `/compact` command and compaction transaction renderer. */
export const ManualCompactionNodeView = memo(function ManualCompactionNodeView({
  node, forkAt, t,
}: ChatNodeViewProps<'manual-compaction'>) {
  const data = node.data
  const outcome = data.command.outcome
  const settledSeq = data.settledSeq
  return (
    <div className={css.callRow}>
      <CompactionCommandCard
        node={data.command}
        {...data.compaction === null ? {} : { compaction: data.compaction }}
        t={t}
      />
      {outcome !== null && (
        <AnswerActionsRow
          text={data.compaction?.summary ?? settledText(outcome, t)}
          time={data.compaction?.time ?? data.command.time}
          onBranch={settledSeq === undefined ? undefined : () => { forkAt(settledSeq) }}
          t={t}
        />
      )}
    </div>
  )
})
