/** `api-session/prompt-hold` and `releaseHeldPrompts` against a production AgentLoop. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { SessionController } from '../src/index.ts'
import type { SessionRequestId } from '../src/types.ts'
import { createSessionTestController, createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

const owned = new Set<Context>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

interface Harness {
  ctx: Context
  agent: Agent
  adapter: MockAdapter
  remote: TestSessionRemote
  controller: SessionController
}

async function harness(script: ConstructorParameters<typeof MockAdapter>[0] = Array.from({ length: 4 }, () => textResponse('reply'))): Promise<Harness> {
  const ctx = new Context()
  owned.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  // `archivedSessionIds` is read by upstream's ArchivedSessionGate on every step.
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [], archivedSessionIds: [] } as never)
  const agent = await loop.create('held-session' as SessionId, { provider: 'mock', model: 'mock' })
  const defaults = { defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp' }
  return {
    ctx,
    agent,
    adapter,
    remote: createSessionTestRemote(ctx, defaults),
    controller: createSessionTestController(ctx, defaults),
  }
}

let nextRequest = 1
async function prompt(h: Harness, text: string): Promise<void> {
  const response = await h.remote.prompt({
    sessionId: h.agent.id,
    requestId: `hold-${String(nextRequest++)}` as SessionRequestId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  })
  if (!response.ok) throw response.error
}

function queuedTexts(agent: Agent): string[] {
  return agent.inbox.nextTurn.flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
}

function turnStarts(agent: Agent): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
}

describe('api-session/prompt-hold', () => {
  it('wakes the Agent as before when no listener holds', async () => {
    const h = await harness()
    await prompt(h, 'go')
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(1)
    expect(queuedTexts(h.agent)).toEqual([])
  })

  it('keeps a held follow-up in the durable queue without starting a turn', async () => {
    const h = await harness()
    h.ctx.on('api-session/prompt-hold', sessionId => sessionId === h.agent.id ? true : undefined)
    await prompt(h, 'first')
    await prompt(h, 'second')
    await h.agent.whenIdle()
    expect(h.agent.status).toBe('idle')
    expect(turnStarts(h.agent)).toBe(0)
    expect(h.adapter.requests).toHaveLength(0)
    expect(queuedTexts(h.agent)).toEqual(['first', 'second'])
    expect(h.agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced')).toBe(true)
  })

  it('lets a held follow-up be edited and removed from the queue', async () => {
    const h = await harness()
    h.ctx.on('api-session/prompt-hold', () => true)
    await prompt(h, 'draft')
    await prompt(h, 'unwanted')
    const [draft, unwanted] = h.agent.inbox.nextTurn
    const edited = await h.remote.updateQueue({
      sessionId: h.agent.id,
      itemId: draft!.id,
      action: { kind: 'edit', content: [{ type: 'text', text: 'final' }] },
    })
    const removed = await h.remote.updateQueue({
      sessionId: h.agent.id,
      itemId: unwanted!.id,
      action: { kind: 'remove' },
    })
    expect(edited.ok && removed.ok).toBe(true)
    expect(queuedTexts(h.agent)).toEqual(['final'])
    expect(turnStarts(h.agent)).toBe(0)
  })

  it('releases held follow-ups in order, each exactly once, only after the hold ends', async () => {
    const h = await harness()
    let holding = true
    h.ctx.on('api-session/prompt-hold', () => holding ? true : undefined)
    await prompt(h, 'first')
    await prompt(h, 'second')

    expect(await h.controller.releaseHeldPrompts(h.agent.id)).toBe(0)
    expect(queuedTexts(h.agent)).toEqual(['first', 'second'])

    holding = false
    expect(await h.controller.releaseHeldPrompts(h.agent.id)).toBe(2)
    await h.agent.whenIdle()
    expect(queuedTexts(h.agent)).toEqual([])
    expect(turnStarts(h.agent)).toBe(2)
    expect(h.adapter.requests).toHaveLength(2)
    const userTexts = h.agent.session.deriveMessages().flatMap(item => item.role === 'user'
      ? item.content.flatMap(part => part.type === 'text' ? [part.text] : [])
      : [])
    expect(userTexts).toEqual(['first', 'second'])

    expect(await h.controller.releaseHeldPrompts(h.agent.id)).toBe(0)
    await h.agent.whenIdle()
    expect(h.adapter.requests).toHaveLength(2)
  })

  it('leaves the queue to a running Agent, whose driver claims it', async () => {
    const h = await harness(['hang'])
    await prompt(h, 'long')
    expect(h.agent.status).toBe('running')
    h.agent.inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: 'after' }], source: { kind: 'user' },
    }))
    expect(await h.controller.releaseHeldPrompts(h.agent.id)).toBe(0)
    expect(queuedTexts(h.agent)).toEqual(['after'])
    h.agent.cancel({ kind: 'user' })
    await h.agent.whenIdle()
  })
})
