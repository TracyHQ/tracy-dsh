import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'claimed-plugin': { kind: 'claimed-plugin' } & ContextFormed
  }
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function texts(messages: readonly { content: readonly unknown[] }[]): string[] {
  return messages.map(message => message.content
    .map(block => (block as { text?: string }).text ?? '')
    .join(''))
}

function loggedUserTexts(agent: Agent): string[] {
  return texts(agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : []))
}

function pending(agent: Agent): string[] {
  return texts([...agent.inbox.nextStep, ...agent.inbox.nextTurn])
}

function turnEndings(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

describe('Tracy: claimed input survives a step that fails before admitting it', () => {
  it('returns a prompt to the queue when agent/request refuses the first attempt, and sends it once later', async () => {
    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-request'), { provider: 'mock', model: 'mock' })
    let refusals = 1
    ctx.on('agent/request', async (_payload, next) => {
      if (refusals > 0) {
        refusals -= 1
        throw new LlmError('Model Subscription is unavailable. Please try again.', 'tracy/subscription-unavailable')
      }
      return next()
    })

    send(agent, 'build my page')
    await agent.whenIdle()

    expect(turnEndings(agent)).toEqual(['error'])
    expect(adapter.requests).toHaveLength(0)
    expect(loggedUserTexts(agent)).toEqual([])
    expect(texts(agent.inbox.nextTurn)).toEqual(['build my page'])

    send(agent, 'and a contact form')
    await agent.whenIdle()

    expect(loggedUserTexts(agent)).toEqual(['build my page', 'and a contact form'])
    expect(adapter.requests).toHaveLength(2)
    expect(pending(agent)).toEqual([])
  })

  it('returns a prompt to the queue when agent/pre-step throws', async () => {
    const adapter = new MockAdapter([textResponse('answer')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-pre-step'), { provider: 'mock', model: 'mock' })
    let throws = 1
    ctx.on('agent/pre-step', async (_payload, next) => {
      if (throws > 0) {
        throws -= 1
        throw new Error('policy listener failed')
      }
      return next()
    })

    send(agent, 'hello')
    await agent.whenIdle()

    expect(turnEndings(agent)).toEqual(['error'])
    expect(loggedUserTexts(agent)).toEqual([])
    expect(texts(agent.inbox.nextTurn)).toEqual(['hello'])
  })

  it('returns step input claimed between steps to next-step, ahead of later steering', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'noop', {}), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-step'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'noop',
      description: '',
      parameters: {},
      async execute() {
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } }))
        return []
      },
    }))
    ctx.on('agent/request', async ({ step }, next) => {
      if (step === 2) throw new Error('refused on the second step')
      return next()
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(turnEndings(agent)).toEqual(['error'])
    expect(loggedUserTexts(agent)).toEqual(['go'])
    expect(texts(agent.inbox.nextStep)).toEqual(['steer'])
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('keeps a message a listener already put back exactly once', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-listener-requeue'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/pre-step', async ({ messages }) => {
      for (const message of messages) agent.inbox.append('next-turn', message)
      throw new Error('listener requeued, then failed')
    })

    send(agent, 'once')
    await agent.whenIdle()

    expect(texts(agent.inbox.nextTurn)).toEqual(['once'])
  })

  it('drops plugin-produced input with the failed step, as before', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-plugin-input'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request', async () => {
      throw new Error('refused')
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'goal round' }], source: { kind: 'claimed-plugin' } }))
    send(agent, 'typed by the person')
    await agent.whenIdle()

    expect(pending(agent)).toEqual(['typed by the person'])
  })

  it('drops a subagent session\'s prompt with the failed step, so its settlement never waits on it', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('claimed-child'),
      meta: { cwd: '/w', parentSession: SessionId('claimed-parent'), origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    ctx.on('agent/request', async () => {
      throw new Error('refused')
    })

    send(agent, 'delegated task')
    await agent.whenIdle()

    expect(turnEndings(agent)).toEqual(['error'])
    expect(pending(agent)).toEqual([])
  })

  it('requeues nothing after the first attempt admitted the users', async () => {
    const adapter = new MockAdapter([
      () => { throw new LlmError('busy', 'RATE_LIMIT') },
      textResponse('unused'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-retry'), { provider: 'mock', model: 'mock' })
    let requests = 0
    ctx.on('agent/request', async (_payload, next) => {
      requests += 1
      if (requests === 2) throw new Error('refused on the retry')
      return next()
    })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))

    send(agent, 'only once')
    await agent.whenIdle()

    expect(turnEndings(agent)).toEqual(['error'])
    expect(loggedUserTexts(agent)).toEqual(['only once'])
    expect(pending(agent)).toEqual([])
  })

  it('leaves cancellation to clear the inbox as before', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-cancel'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request', async (_payload, next) => {
      agent.cancel({ kind: 'user' })
      return next()
    })

    send(agent, 'stop this')
    await agent.whenIdle()

    expect(turnEndings(agent)).toEqual(['aborted'])
    expect(loggedUserTexts(agent)).toEqual([])
    expect(pending(agent)).toEqual([])
  })

  it('reports both failures when the claimed input cannot be returned', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('claimed-requeue-fails'), { provider: 'mock', model: 'mock' })
    let refusing = false
    ctx.on('agent/request', async () => {
      refusing = true
      throw new Error('refused')
    })
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event' || !refusing) return
      const event = args[1] as SessionEvent
      if (event.type === 'agent/inbox/spliced') throw new Error('inbox write refused')
    })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => void errors.push(error))

    send(agent, 'lost')
    await agent.whenIdle()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(AggregateError)
    expect((errors[0] as AggregateError).errors.map(error => (error as Error).message))
      .toEqual(['refused', 'inbox write refused'])
  })
})
