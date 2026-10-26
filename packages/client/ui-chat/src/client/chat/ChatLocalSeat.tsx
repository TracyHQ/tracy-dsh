/** One client-local row: dispatched to its renderer like a log row, minus the Turn-process machinery. */
import { memo, useMemo, useState } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChatNodeHookContext, ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatLocalNode } from '../contract/chat-local.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import css from './ChatView.module.css'

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

interface ChatLocalSeatProps extends Omit<ChatNodeOwnerProps, 'turnProcess' | 'groupPart'> {
  readonly node: ChatLocalNode
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

export const ChatLocalSeat = memo(function ChatLocalSeat({ node, renderSlot, t, ...owner }: ChatLocalSeatProps) {
  // A local row has no Turn: no Turn data, and no process disclosure to reset.
  const [disclosureReset] = useState(() => createSnapshotStore(0))
  const hookContext = useMemo<ChatNodeHookContext>(() => ({ turnData: undefined, disclosureReset }), [disclosureReset])
  const routedOwner = { ...owner, node } as unknown as RoutedChatNodeOwner
  return (
    // No `data-chat-flow-key`: that marks log rows the scroll memory may anchor on,
    // and a local row is gone after a reload.
    // `data-chat-exchange` (Tracy, tracy.42): a request or its answer, which takes the
    // always-visible action row from the answers above it.
    <div className={css.flowItem} data-chat-node-key={node.key} data-chat-flow-kind={node.kind} data-chat-local=""
      data-chat-exchange={node.exchange === true ? '' : undefined}>
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: node.kind,
        hookContext,
        // A local kind nobody renders (its plugin is gone) draws nothing.
        fallback: null,
      })}
    </div>
  )
})
