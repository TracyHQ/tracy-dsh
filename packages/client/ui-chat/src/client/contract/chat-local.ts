/**
 * Client-local chat nodes: rows a plugin draws in the transcript that are NOT
 * in the session log. They never reach the host, the session export, the turn
 * data or the agent's context; they live in this browser (a plugin that wants
 * them back after a reload stores them itself and upserts them again).
 */
import type { ComponentType } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode, ChatNodeDataMap, ChatNodeKind } from './chat-nodes.ts'

/** One local row, narrowed to a registered renderer kind and its payload. */
export type ChatLocalNode<Kind extends ChatNodeKind = ChatNodeKind> = {
  [RegisteredKind in Kind]: ChatConversationViewNode & {
    readonly kind: RegisteredKind
    readonly data: ChatNodeDataMap[RegisteredKind]
    /** Insertion order among local rows, the tiebreak after `anchorSeq`. */
    readonly order: number
    /** The row is a request or its answer (Tracy, tracy.42): see `ChatLocalNodeInput.exchange`. */
    readonly exchange?: boolean
  }
}[Kind]

/** What a plugin hands to `upsert`. */
export type ChatLocalNodeInput<Kind extends ChatNodeKind = ChatNodeKind> = {
  [RegisteredKind in Kind]: {
    /** Plugin-owned identity, unique within the session; upserting the same id replaces the row in place. */
    readonly id: string
    readonly kind: RegisteredKind
    /**
     * Durable seq of the last log entry the row follows. The row sits after every
     * log row with `anchorSeq <= this`, so an agent row that arrives later
     * (greater seq) is drawn below it.
     */
    readonly anchorSeq: number
    readonly data: ChatNodeDataMap[RegisteredKind]
    /**
     * The row is a request the person made, or its answer (Tracy, tracy.42). Its
     * flow item carries `data-chat-exchange`, so an earlier answer gives its
     * action row up to the hover reveal (MessageIconActions.module.css). A tip
     * or any other note leaves it out.
     */
    readonly exchange?: boolean
  }
}[Kind]

/** One session's local rows. */
export interface ChatLocalSession {
  /** Add the row, or replace the row with the same id keeping its place among equal anchors. */
  upsert(input: ChatLocalNodeInput): void
  /** Remove one row; unknown ids are ignored. */
  remove(id: string): void
  /** Remove every row of this session. */
  clear(): void
  /**
   * Synchronous read of where the log stands: the largest `anchorSeq` among this
   * session's Chat nodes in the current snapshot, `-1` when it has none. Pass it
   * as `anchorSeq` to draw a row after everything logged so far. May be fractional
   * (synthetic nodes sit between durable seqs); no subscription is needed.
   */
  tailSeq(): number
  /** The rows in draw order (`anchorSeq`, then insertion order). Identity changes only with the rows. */
  readonly nodes: ObservableSnapshot<readonly ChatLocalNode[]>
}

/** Like/Dislike of an answer whose rating the caller stores itself (Tracy, tracy.42). */
export interface AnswerFeedback {
  /** The recorded rating, or null when the answer is not rated. */
  readonly rating: 'positive' | 'negative' | null
  /**
   * A thumb was pressed. Pressing the recorded rating means "remove it"; the
   * caller records or retracts and hands the new `rating` back.
   */
  readonly rate: (rating: 'positive' | 'negative') => void
  /** A rating is being saved: both thumbs are disabled. */
  readonly pending?: boolean
  /** Button names, in the interface language (the agent row reads them from the `feedback` namespace). */
  readonly labels: {
    readonly like: string
    readonly likeActive: string
    readonly dislike: string
    readonly dislikeActive: string
  }
}

/**
 * Props of `ctx.chatLocal.AnswerActions` (Tracy, tracy.42): the agent reply's
 * action row (copy, Like/Dislike, branch, clock) under a client-local answer.
 * It draws in the transcript and anywhere else the plugin shows that answer.
 */
export interface LocalAnswerActionsProps {
  /** The session the answer belongs to; branch forks this session. */
  readonly sessionId: SessionId
  /** Plain text the copy action writes. */
  readonly text: string
  /** Unix epoch ms of the answer, for the clock; omitted shows no clock. */
  readonly time?: number | undefined
  /**
   * Durable seq to branch the session at (inclusive cut); omitted hides branch.
   * A fractional `tailSeq()` is floored to the durable event before it.
   */
  readonly branchAt?: number | undefined
  /** The answer's rating; omitted draws no Like/Dislike. */
  readonly feedback?: AnswerFeedback | undefined
}

/** The `ctx.chatLocal` service face. */
export interface ChatLocalContract {
  /** @param sessionId - target session. @returns its local rows, created on first use. */
  for(sessionId: SessionId): ChatLocalSession
  /**
   * The agent reply's action row for a local answer, in the interface language
   * (Tracy, tracy.42). It shows only once the plugin draws it: an answer still
   * being written draws none.
   */
  readonly AnswerActions: ComponentType<LocalAnswerActionsProps>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client-local transcript rows (not in the session log). */
    chatLocal: ChatLocalContract
  }
}
