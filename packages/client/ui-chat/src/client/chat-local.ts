/** Per-session store behind `ctx.chatLocal`. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComponentType } from 'react'
import type {
  ChatLocalContract, ChatLocalNode, ChatLocalNodeInput, ChatLocalSession, LocalAnswerActionsProps,
} from './contract/chat-local.ts'
import type { ChatSnapshot } from './contract/snapshot.ts'

/** Reads one session's current Chat snapshot, or nothing when the session is unknown. */
export type ChatSnapshotReader = (sessionId: SessionId) => ChatSnapshot | undefined

/** Key prefix keeping a local row's key apart from every log row's key. */
const KEY_PREFIX = 'local:'

function sortRows(rows: readonly ChatLocalNode[]): readonly ChatLocalNode[] {
  return [...rows].sort((left, right) => left.anchorSeq - right.anchorSeq || left.order - right.order)
}

function createSession(sessionId: SessionId, read: ChatSnapshotReader): ChatLocalSession {
  const store = createSnapshotStore<readonly ChatLocalNode[]>([])
  let counter = 0
  return {
    nodes: store,
    upsert: (input: ChatLocalNodeInput) => {
      const rows = store.getSnapshot()
      const key = KEY_PREFIX + input.id
      const existing = rows.find(row => row.key === key)
      const row = {
        key,
        id: input.id,
        kind: input.kind,
        target: 'chat',
        anchorSeq: input.anchorSeq,
        location: { kind: 'session' },
        visibility: 'visible',
        data: input.data,
        order: existing?.order ?? ++counter,
        ...input.exchange === true ? { exchange: true } : {},
      } as ChatLocalNode
      store.set(sortRows([...rows.filter(item => item.key !== key), row]))
    },
    remove: (id) => {
      const key = KEY_PREFIX + id
      const rows = store.getSnapshot()
      if (rows.some(row => row.key === key)) store.set(rows.filter(row => row.key !== key))
    },
    clear: () => {
      if (store.getSnapshot().length > 0) store.set([])
    },
    tailSeq: () => {
      let tail = -1
      for (const node of read(sessionId)?.nodes.values() ?? []) tail = Math.max(tail, node.anchorSeq)
      return tail
    },
  }
}

/** Draws nothing: the service built without a view (tests of the row store). */
const NO_ACTIONS: ComponentType<LocalAnswerActionsProps> = () => null

/**
 * @param read - the session's current Chat snapshot, for `tailSeq`.
 * @param AnswerActions - the action row local answers draw (`apply.ts` binds it to the locale and the session fork).
 * @returns the service: one lazily created row list per session.
 */
export function createChatLocal(
  read: ChatSnapshotReader,
  AnswerActions: ComponentType<LocalAnswerActionsProps> = NO_ACTIONS,
): ChatLocalContract {
  const sessions = new Map<SessionId, ChatLocalSession>()
  return {
    AnswerActions,
    for: (sessionId) => {
      let session = sessions.get(sessionId)
      if (session === undefined) {
        session = createSession(sessionId, read)
        sessions.set(sessionId, session)
      }
      return session
    },
  }
}
