import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Tracy fork: a plan the agent wrote and left unfinished. Two failures measured on a customer
 * session (30/09/2026): a question sent mid-turn made the model answer it and close the turn with
 * seven of eight todos untouched, and the dock kept spinning the abandoned `in_progress` item
 * because the in-flight plan survives turn boundaries. The loop now steers the agent back once per
 * unchanged plan, and a turn that ends anyway stops presenting the agent's work as running.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function run(ctx: Context, id: string, text: string, before?: (agent: Agent) => void): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  before?.(agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return agent
}

function reminders(log: readonly SessionEvent[]): string[] {
  return log.flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'tool-todo') return []
    return event.data.content.flatMap(part => part.type === 'text' ? [part.text] : [])
  })
}

function todos(ctx: Context, agent: Agent): unknown {
  return ctx.sessionProjections.snapshot(agent.session)?.values.todos
}

const PLAN: TodoItem[] = [
  { content: 'home page', status: 'in_progress' },
  { content: 'product page', status: 'pending' },
]

describe('an unfinished plan the agent wrote', () => {
  it('steers the agent back when it tries to close the turn with work left', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: PLAN }),
      textResponse('The site has one language.'),
      toolCallResponse('call-2', 'todo_write', {
        todos: PLAN.map(item => ({ ...item, status: 'completed' })),
      }),
      textResponse('All done.'),
    ])
    const ctx = await harness(adapter)
    const agent = await run(ctx, 'plan-steer', 'do it all')

    const log = agent.session.snapshotEvents()
    const said = reminders(log)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('home page')
    expect(said[0]).toContain('product page')
    // The steer kept the same turn open: one turn, the model called four times.
    expect(log.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(4)
  })

  it('steers once per unchanged plan, so a model that stops again ends the turn', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: PLAN }),
      textResponse('Stopping here.'),
      textResponse('Still stopping.'),
    ])
    const ctx = await harness(adapter)
    const agent = await run(ctx, 'plan-once', 'do it all')

    expect(reminders(agent.session.snapshotEvents())).toHaveLength(1)
    expect(adapter.requests).toHaveLength(3)
  })

  it('does not steer when every todo is completed', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'one', status: 'completed' }] }),
      textResponse('Done.'),
    ])
    const ctx = await harness(adapter)
    const agent = await run(ctx, 'plan-done', 'do it')

    expect(reminders(agent.session.snapshotEvents())).toHaveLength(0)
  })

  it('does not steer over a plan the host wrote (a site build reports its own stages)', async () => {
    const adapter = new MockAdapter([textResponse('Your site is building.')])
    const ctx = await harness(adapter)
    const agent = await run(ctx, 'plan-host', 'how is it going?', (subject) => {
      subject.session.append('todo/write', { todos: PLAN })
    })

    expect(reminders(agent.session.snapshotEvents())).toHaveLength(0)
    // The build is still running: its stage keeps spinning after the turn.
    expect(todos(ctx, agent)).toEqual(PLAN)
  })

  it('stops presenting the agent\'s abandoned work as running once its turn ends', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: PLAN }),
      textResponse('Stopping here.'),
      textResponse('Still stopping.'),
    ])
    const ctx = await harness(adapter)
    const agent = await run(ctx, 'plan-settle', 'do it all')

    expect(todos(ctx, agent)).toEqual([
      { content: 'home page', status: 'pending' },
      { content: 'product page', status: 'pending' },
    ])
  })

  it('marks the snapshot the tool appends as the agent\'s own', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'one', status: 'completed' }] }),
      textResponse('Done.'),
    ])
    const ctx = await harness(adapter)
    const agent = await run(ctx, 'plan-owner', 'do it')

    const written = agent.session.snapshotEvents().find(event => event.type === 'todo/write')
    expect(written?.data).toEqual({ todos: [{ content: 'one', status: 'completed' }], by: 'agent' })
  })
})
