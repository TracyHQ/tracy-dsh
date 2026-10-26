/**
 * Service Definition for the user-questions capability seam (`ctx.userQuestions`): a UI-backed service for
 * pausing an agent tool call until the human answers a question. The model-
 * facing tool lives in `@deepseek-ai/dsh-tool-ask-user`; UI packages compose
 * answerers on the Agent-scoped Cordis waterfall.
 *
 * @module @deepseek-ai/dsh-user-questions
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError, type MessageId, type ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { userQuestionProjectionDefinition } from './projection.ts'
import { TimedQuestionWait } from './timed-wait.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

import type {
  AskUserQuestionAction, AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent, PendingUserQuestion,
} from './types.ts'

export type {
  AskUserQuestionAction, AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionIntent, AskUserQuestionItem,
  AskUserQuestionOption, PendingUserQuestion, SettledUserQuestion, UserQuestionProjectionView,
  UserQuestionState,
} from './types.ts'
export { isTimedAskUserQuestionSchema, TIMED_WAIT_PARAMETER } from './projection.ts'

/**
 * How an answer closed its request; an answerer that sets no `action` submitted it.
 * @param answer - Answer returned by `ask()`.
 * @returns The answer's action, `submit` when absent.
 */
export function answerAction(answer: AskUserQuestionAnswer): AskUserQuestionAction {
  return answer.action ?? 'submit'
}

/** A trailing parenthetical on a label, such as " (Recommended)" or " (Đề xuất)". */
const TRAILING_NOTE = /\s*[(\uFF08][^()\uFF08\uFF09]*[)\uFF09]\s*$/u

/**
 * A label as `recommended` is compared with it: Unicode-normalised, trimmed, case-folded, without
 * a trailing parenthetical note, and with inner runs of white space collapsed.
 * @param label - an option label, or the `recommended` value.
 * @returns the comparable form.
 */
function comparableLabel(label: string): string {
  return label.normalize('NFC').trim().replace(TRAILING_NOTE, '').replace(/\s+/gu, ' ').toLocaleLowerCase()
}

/**
 * The option a `recommended` value means. Models restate a label rather than copy it: they add
 * or drop the "(Recommended)" note (in any language), change case, or give only the label's
 * opening words. Accepted, in this order and only when exactly one option qualifies: the label
 * itself; the label equal after {@link comparableLabel}; the one label that starts with the
 * value at a word boundary. Anything else — no option, or two — names none.
 * @param recommended - the caller's value.
 * @param labels - the question's option labels.
 * @returns the exact label meant, or `undefined`.
 */
function recommendedLabel(recommended: string, labels: readonly string[]): string | undefined {
  if (labels.includes(recommended)) return recommended
  const wanted = comparableLabel(recommended)
  if (wanted === '') return undefined
  const equal = labels.filter(label => comparableLabel(label) === wanted)
  if (equal.length > 0) return equal.length === 1 ? equal[0] : undefined
  const prefixed = labels.filter((label) => {
    const comparable = comparableLabel(label)
    return comparable.startsWith(wanted) && /^[\s,;:.\-–—/]/u.test(comparable.slice(wanted.length))
  })
  return prefixed.length === 1 ? prefixed[0] : undefined
}

/**
 * The question as answerers should see its `recommended`: unchanged when it is absent or names
 * an option exactly, rewritten to the exact label when it means exactly one option
 * ({@link recommendedLabel}), dropped otherwise.
 * @param question - the caller's question.
 * @returns the replacement question, or `undefined` when it is kept as is.
 */
function withResolvedRecommended(question: AskUserQuestionItem): AskUserQuestionItem | undefined {
  const recommended = question.recommended
  if (recommended === undefined) return undefined
  const labels = (question.options ?? []).map(option => option.label)
  const meant = recommendedLabel(recommended, labels)
  if (meant === recommended) return undefined
  const { recommended: _dropped, ...rest } = question
  return meant === undefined ? rest : { ...rest, recommended: meant }
}

/** Request for a human answer. */
export interface AskUserQuestionRequest extends AskUserQuestionRequestEvent {}

/** Timed ask result returned when the foreground answer window closes. */
export type TimedUserQuestionResult = AskUserQuestionAnswer | { pending: true; callId: ToolCallId }

/** Stable error taxonomy for user-questions failures. */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

function abortedQuestion(cause?: unknown): UserQuestionError {
  return new UserQuestionError(
    'ask_user_question was aborted before the user answered',
    'ASK_ABORTED',
    cause === undefined ? undefined : { cause },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreUserQuestionError(reason: unknown): unknown {
  if (reason instanceof UserQuestionError) return reason
  if (isRecord(reason)
    && reason.name === 'UserQuestionError'
    && typeof reason.message === 'string'
    && typeof reason.code === 'string') {
    return new UserQuestionError(reason.message, reason.code, { cause: reason })
  }
  return reason
}

type QueuedReply = { messageId: MessageId; claimedTurn?: number }

/** `ctx.userQuestions`: validation plus the scoped answerer waterfall. */
export class UserQuestionService extends TypertRemoteService {
  static Config = z.object({})
  private readonly waits = new Map<Agent, Map<ToolCallId, TimedQuestionWait>>()
  private readonly queuedReplies = new WeakMap<Session, Map<ToolCallId, QueuedReply>>()

  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(userQuestionProjectionDefinition)
    })
    ctx.effect(() => () => {
      for (const calls of this.waits.values()) {
        for (const wait of calls.values()) wait.close(abortedQuestion())
      }
      this.waits.clear()
    }, 'userQuestions: foreground waits')
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const source = message.source
      if (source.kind !== 'user-question-reply') return
      const calls = this.queuedReplies.get(agent.session) ?? new Map<ToolCallId, QueuedReply>()
      const reply = calls.get(source.callId)
      if (reply === undefined) {
        calls.set(source.callId, { messageId: message.id, claimedTurn: turn })
        this.queuedReplies.set(agent.session, calls)
      } else if (reply.messageId === message.id) {
        reply.claimedTurn = turn
      }
    }, { global: true })
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const source = message.source
      if (source.kind === 'user-question-reply') this.releaseReply(agent.session, source.callId, message.id)
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') {
        const source = event.data.source
        if (source.kind === 'user-question-reply') this.releaseReply(session, source.callId, event.data.id)
      } else if (event.type === 'turn/end') {
        const calls = this.queuedReplies.get(session)
        if (calls === undefined) return
        for (const [callId, reply] of calls) {
          if (reply.claimedTurn === event.data.turn) calls.delete(callId)
        }
      }
    }, { global: true })
  }

  private releaseReply(session: Session, callId: ToolCallId, messageId: MessageId): void {
    const calls = this.queuedReplies.get(session)
    if (calls?.get(callId)?.messageId !== messageId) return
    calls.delete(callId)
  }

  private assertLiveRoot(agent: Agent): void {
    const agents = this.ctx.get('agents')
    if (agents === undefined || agents.get(agent.id) !== agent) {
      throw new UserQuestionError(
        'human interaction requires the exact live calling agent when an agent is supplied',
        'CALLER_NOT_LIVE')
    }
    if (!agents.roots().includes(agent)) {
      throw new UserQuestionError(
        'human interaction is unavailable while the calling agent is owned by another live agent; '
        + "include the unresolved question or decision in the child agent's final result",
        'DELEGATED_CALLER')
    }
  }

  private continued(agent: Agent): readonly PendingUserQuestion[] {
    const state = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'userQuestions')
    return (state?.questions.active ?? []).filter(question => question.state === 'continued')
  }

  /**
   * Answer a continued question. The reply is steered into the agent as a
   * user message whose source names the call; that message is also the
   * record that closes the question in the projection.
   * @param agent - Live root agent for the owning Session.
   * @param callId - Continued question identity.
   * @param answer - Complete structured answer batch, one item per question of the call.
   * @returns Whether the question is still continued; an accepted reply stays
   *   queued until the agent admits its user message.
   * @throws {UserQuestionError} `BAD_ANSWER` when the batch does not name each
   *   question of the call exactly once, or `REPLY_QUEUED` when a reply is
   *   already waiting for admission.
   */
  @Remote
  answer(agent: Agent, callId: ToolCallId, answer: AskUserQuestionAnswer): boolean {
    this.assertLiveRoot(agent)
    const question = this.continued(agent).find(item => item.callId === callId)
    if (question === undefined) return false
    const queued = this.queuedReplies.get(agent.session)
    const matches = (message: UserMessage): boolean =>
      message.source.kind === 'user-question-reply' && message.source.callId === callId
    if (queued?.has(callId) || agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) {
      throw new UserQuestionError('a reply is already queued for this question', 'REPLY_QUEUED')
    }
    // The gateway validated the batch's shape from the type; the model-facing
    // contract also promises one item per question, which only this owner of
    // the asked questions can check before the batch reaches the model.
    const answered = new Set(answer.answers.map(item => item.id))
    if (answered.size !== answer.answers.length
      || question.questions.length !== answer.answers.length
      || !question.questions.every(item => answered.has(item.id))) {
      throw new UserQuestionError(
        `the answer batch for ${callId} must name each of its ${String(question.questions.length)} questions exactly once`,
        'BAD_ANSWER')
    }
    const message = createUserMessage({
      source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'answer_to_pending_question', tool: 'ask_user_question', callId,
          questions: question.questions, answers: answer.answers,
        }),
      }],
    })
    const calls = queued ?? new Map<ToolCallId, QueuedReply>()
    calls.set(callId, { messageId: message.id })
    this.queuedReplies.set(agent.session, calls)
    try {
      agent.steer(message)
    } catch (error: unknown) {
      this.releaseReply(agent.session, callId, message.id)
      throw error
    }
    return true
  }

  /**
   * Let one answer UI hold a live timed wait. Closing the stream releases its claim.
   * @param agent - Live root agent owning the question.
   * @param callId - Foreground tool call to attach to.
   * @param signal - Remote stream cancellation, including Client disconnect.
   * @returns One Host-computed remaining duration, or no frames once the wait ended.
   */
  @Remote({ mode: 'stream' })
  async *attachWait(agent: Agent, callId: ToolCallId, signal: AbortSignal): AsyncIterable<{ remainingMs: number }> {
    this.assertLiveRoot(agent)
    const wait = this.waits.get(agent)?.get(callId)
    if (wait !== undefined) yield* wait.attach(signal)
  }

  /**
   * Foreground wait whose first settlement the Client decides: the Client
   * rejects with `ASK_TIMED_OUT` when its countdown ends, and this method maps
   * that code to the pending result.
   * @param request - Questions, live owner agent, and abort signal.
   * @param callId - Tool call identity the Client card is keyed by.
   * @param timeoutMs - Positive foreground wait in milliseconds.
   * @returns The answer when it arrives inside the window, otherwise a pending
   *   result, also when no connected Client claimed the request by the deadline.
   * @throws {UserQuestionError} `BAD_TIMEOUT` for a non-integer, non-positive,
   *   or oversized wait.
   */
  async askTimed(
    request: AskUserQuestionRequest & { agent: Agent },
    callId: ToolCallId,
    timeoutMs: number,
  ): Promise<TimedUserQuestionResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new UserQuestionError('timeout must fit a positive platform timer', 'BAD_TIMEOUT')
    }
    this.assertLiveRoot(request.agent)
    const calls = this.waits.get(request.agent) ?? new Map<ToolCallId, TimedQuestionWait>()
    if (calls.has(callId)) throw new UserQuestionError('the question call already has a foreground wait', 'DUPLICATE_WAIT')
    const wait = new TimedQuestionWait(Date.now() + timeoutMs, request.signal,
      new UserQuestionError('ask_user_question timed out before the user answered', 'ASK_TIMED_OUT'))
    calls.set(callId, wait)
    this.waits.set(request.agent, calls)
    try {
      try {
        return await this.ask({ ...request, signal: wait.signal, wait: { callId, timed: true } })
      } catch (error) {
        if (wait.signal.aborted) throw wait.signal.reason
        if (error instanceof UserQuestionError && error.code === 'NO_PROVIDER') {
          await wait.done
          throw wait.signal.reason
        }
        throw error
      }
    } catch (error) {
      if (error instanceof UserQuestionError && error.code === 'ASK_TIMED_OUT') return { pending: true, callId }
      if (wait.signal.aborted) throw abortedQuestion(error)
      throw error
    } finally {
      wait.close(abortedQuestion())
      calls.delete(callId)
      if (calls.size === 0) this.waits.delete(request.agent)
    }
  }

  /**
   * Ask the scoped answerer waterfall and wait for the user's answer.
   *
   * When a caller supplies an agent, human interaction is valid only for the
   * exact live runtime root. Runtime ownership, not durable session lineage,
   * decides this boundary: an owned child has no human answerer and would
   * block forever, while a lineage-bearing session resumed as a new runtime
   * root may ask normally.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `ASK_ABORTED` when the supplied signal
   *   is already or becomes aborted, `CALLER_NOT_LIVE` when a supplied agent
   *   is not the registry's exact live instance, or `DELEGATED_CALLER` when
   *   that live agent is owned by another agent.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw abortedQuestion()
    }
    if (request.questions.length === 0) {
      throw new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const agent = request.agent
    if (agent !== undefined) this.assertLiveRoot(agent)
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
    // A `recommended` is a presentation hint: one that means exactly one option
    // is rewritten to that option's exact label, so every UI matches it by
    // equality; one that names none (or several) is dropped, so no UI
    // pre-selects a choice that was never offered, and the question goes
    // through either way. The request is copied only when something changed,
    // so answerers otherwise keep seeing the caller's own objects.
    let questions = request.questions
    request.questions.forEach((question, index) => {
      const resolved = withResolvedRecommended(question)
      if (resolved === undefined) return
      this.ctx.logger.debug(resolved.recommended === undefined
        ? `question ${question.id}: recommended ${JSON.stringify(question.recommended)} names none of its options; dropped`
        : `question ${question.id}: recommended ${JSON.stringify(question.recommended)} read as ${JSON.stringify(resolved.recommended)}`)
      if (questions === request.questions) questions = [...request.questions]
      questions[index] = resolved
    })
    const asked = questions === request.questions ? request : { ...request, questions }
    const noAnswerer = () => Promise.reject(new UserQuestionError(
      'no user-questions answerer accepted the request',
      'NO_PROVIDER',
    ))
    try {
      return await (agent === undefined
        ? this.ctx.waterfall('user-questions/request', asked, noAnswerer)
        : this.ctx.waterfall(
          scopeTarget(agent, agent),
          'user-questions/request',
          { ...asked, agent },
          noAnswerer,
        ))
    } catch (error) {
      const restored = restoreUserQuestionError(error)
      if (restored instanceof UserQuestionError) throw restored
      if (request.signal?.aborted) {
        throw abortedQuestion(error)
      }
      throw restored
    }
  }
}

export default UserQuestionService
