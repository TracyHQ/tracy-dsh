// @vitest-environment jsdom
/**
 * Tracy (tracy.42): the agent reply's action row for answers that are not an
 * agent turn: a client-local answer (`ctx.chatLocal.AnswerActions`). The
 * settled slash command's row is in chat-view.client.spec.tsx, and the rule that
 * only the last finished answer keeps it out in chat-font-axis-styles.client.spec.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AnswerActionsRow } from '../src/client/chat/AnswerActions.tsx'
import { bindLocalAnswerActions, branchSeqOf } from '../src/client/chat/LocalAnswerActions.tsx'
import { createChatLocal } from '../src/client/chat-local.ts'
import type { AnswerFeedback } from '../src/client/contract/chat-local.ts'
import { zh } from '../src/client/locale.ts'

afterEach(() => { cleanup() })

const t = makeTranslate(zh, commonZh)
const SID = 'session-1' as SessionId
const labels = { like: 'Good response', likeActive: 'Remove rating', dislike: 'Bad response', dislikeActive: 'Remove rating' }
const buttons = (root: HTMLElement) => [...root.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))

describe('AnswerActionsRow', () => {
  it('draws the agent row in its order: copy, Like, Dislike, branch, then the clock', () => {
    const rate = vi.fn()
    const feedback: AnswerFeedback = { rating: null, rate, labels }
    const view = render(<AnswerActionsRow text="the answer" time={new Date(2026, 9, 12, 0, 2).getTime()}
      onBranch={() => {}} feedback={feedback} t={t} />)
    const row = view.container.querySelector('[data-answer-actions]') as HTMLElement
    expect(row.getAttribute('data-actions-reveal')).toBe('always')
    expect(buttons(row)).toEqual(['复制', 'Good response', 'Bad response', '在新对话中分支'])
    expect(row.querySelector('[data-clock="end"]')?.lastElementChild?.textContent).toMatch(/\d{2}:\d{2}|月/)
    fireEvent.click(view.getByRole('button', { name: 'Good response' }))
    expect(rate).toHaveBeenCalledWith('positive')
    fireEvent.click(view.getByRole('button', { name: 'Bad response' }))
    expect(rate).toHaveBeenCalledWith('negative')
  })

  it('shows a recorded rating filled and pressed, named for removal', () => {
    const view = render(<AnswerActionsRow text="x" feedback={{ rating: 'negative', rate: () => {}, labels }} t={t} />)
    const pressed = view.container.querySelectorAll('[aria-pressed="true"]')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.getAttribute('aria-label')).toBe('Remove rating')
    expect(view.getByRole('button', { name: 'Good response' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('draws no thumbs without feedback and no branch without a cut', () => {
    const view = render(<AnswerActionsRow text="x" t={t} />)
    expect(buttons(view.container)).toEqual(['复制'])
  })

  it('disables both thumbs while a rating is saved', () => {
    const view = render(<AnswerActionsRow text="x" feedback={{ rating: null, rate: () => {}, pending: true, labels }} t={t} />)
    expect((view.getByRole('button', { name: 'Good response' }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: 'Bad response' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ctx.chatLocal.AnswerActions', () => {
  it('is part of the service, and draws nothing in a store built without a view', () => {
    const local = createChatLocal(() => undefined)
    const view = render(<local.AnswerActions sessionId={SID} text="x" />)
    expect(view.container.innerHTML).toBe('')
  })

  it('branches the session at the durable event under the answer', () => {
    const forkAt = vi.fn()
    const locale = createSnapshotStore(0)
    const local = createChatLocal(() => undefined, bindLocalAnswerActions({ t, locale, forkAt }))
    const view = render(<local.AnswerActions sessionId={SID} text="x" branchAt={7.1} />)
    fireEvent.click(view.getByRole('button', { name: '在新对话中分支' }))
    expect(forkAt).toHaveBeenCalledWith(SID, 7)
  })

  it('hides branch where the session has no log yet', () => {
    const local = createChatLocal(() => undefined,
      bindLocalAnswerActions({ t, locale: createSnapshotStore(0), forkAt: vi.fn() }))
    const view = render(<local.AnswerActions sessionId={SID} text="x" branchAt={-1} />)
    expect(buttons(view.container)).toEqual(['复制'])
    expect(branchSeqOf(undefined)).toBeUndefined()
    expect(branchSeqOf(0)).toBe(0)
  })

  it('redraws when the interface language changes', () => {
    const locale = createSnapshotStore(0)
    let language: 'zh' | 'en' = 'zh'
    const translate = ((key: string, params?: Record<string, unknown>) =>
      language === 'zh' ? t(key as never, params as never) : `en:${key}`) as typeof t
    const Actions = bindLocalAnswerActions({ t: translate, locale, forkAt: vi.fn() })
    const view = render(<Actions sessionId={SID} text="x" />)
    expect(buttons(view.container)).toEqual(['复制'])
    act(() => {
      language = 'en'
      locale.set(1)
    })
    expect(buttons(view.container)).toEqual(['en:copy'])
  })
})
