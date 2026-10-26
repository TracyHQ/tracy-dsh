/**
 * Model-facing whole-list replacement. Each call appends a `todo/write` snapshot to the calling
 * agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
 * caller has no owning list and is rejected. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-todo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TodoItem, TodoPlanState } from './types.ts'
// Type-only: resolves the `agent/turn-stopping` event declaration.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: resolves the required ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// The `todos` projection-key declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionProjectionMap merge.
export type * from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Tracy fork: the reminder steering the agent back to its unfinished plan. */
    'tool-todo': { kind: 'tool-todo' } & ContextFormed
  }
}

export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

/** The valid {@link TodoItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

/** Model-facing todo tool configuration. */
export interface Config {
  /**
   * Required deployment choice for whether several todos may be `in_progress` at once. True suits
   * agents that run work concurrently — subagents, background commands, workflow fan-out — and the
   * description then instructs the model to mark every actively worked task. False restores the
   * single-active discipline: the description asks for exactly one, and a call marking more is
   * rejected.
   */
  allowParallelInProgress: boolean
}

/** Schemastery configuration for the todo tool consumer. */
export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),
})

const DESCRIPTION_HEAD =
  'Record and update a task list to plan multi-step work and show progress; skip it for trivial '
  + 'single-step tasks. Add one todo per concrete step before you start. '

const DESCRIPTION_PARALLEL =
  'While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. '

const DESCRIPTION_SINGLE =
  'While work remains, keep exactly one todo `in_progress`. '

const DESCRIPTION_TAIL = 'Mark each todo `completed` as soon as it is done.'

/**
 * The model-facing description for one activation. The active-status clause is the only part that
 * varies, because it is the only instruction the parallel policy changes.
 * @param allowParallel - whether several todos may be `in_progress` at once.
 * @returns the composed tool description.
 */
function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD
    + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE)
    + DESCRIPTION_TAIL
}

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and build the canonical {@link
 * TodoItem}[]: trimmed non-empty unique content, and at most one `in_progress` item unless the
 * deployment allows parallel work. The registry has already enforced the status enum and rejected
 * unknown item keys (`additionalProperties: false` — the logged snapshot must equal what the model
 * believes it wrote, so a nested/extended item shape fails loud at the schema boundary instead of
 * silently flattening); the cast below records that guarantee.
 * @param raw - the model-supplied list, already schema-checked.
 * @param allowParallel - whether several items may be `in_progress` at once.
 * @returns the canonical list.
 */
function toTodoList(raw: { content: string; status: string }[], allowParallel: boolean): TodoItem[] {
  const todos: TodoItem[] = []
  const seen = new Set<string>()
  let active = 0
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) {
      throw new Error('invalid todo: `content` must be a non-empty string')
    }
    if (seen.has(content)) {
      throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    }
    seen.add(content)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status as TodoItem['status'] })
  }
  if (!allowParallel && active > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  }
  return todos
}

const todoItemSchema = zod.object({
  content: zod.string(),
  status: zod.union([zod.literal('pending'), zod.literal('in_progress'), zod.literal('completed')]),
})

/** Wire payload schema of the `todos` projection (whole list or pre-first-write null). */
const todosProjectionSchema: ZodType<TodoItem[] | null> = zod.union([zod.array(todoItemSchema), zod.null()])

/** Fold state schema of the `todos` projection: the list plus who wrote it. */
const todoPlanStateSchema: ZodType<TodoPlanState | null> = zod.union([
  zod.object({ todos: zod.array(todoItemSchema), byAgent: zod.boolean() }),
  zod.null(),
])

/** Whether a standing plan still has work in progress — the one a new turn must not blank. */
function inFlight(state: TodoPlanState | null): boolean {
  return state !== null && state.todos.some(item => item.status === 'in_progress')
}

/**
 * Tracy fork: the agent's own plan once its turn has ended. Nothing works on an agent's todo
 * between its turns, so an `in_progress` item left behind is shown as not started rather than
 * running; a host-written list is left alone because the host keeps working outside any turn.
 * @param state - the fold state at `turn/end`.
 * @returns the same reference when nothing changes.
 */
function settle(state: TodoPlanState | null): TodoPlanState | null {
  if (state === null || !state.byAgent || !inFlight(state)) return state
  return {
    byAgent: true,
    todos: state.todos.map(item => item.status === 'in_progress' ? { ...item, status: 'pending' } : item),
  }
}

/**
 * Where the steer message comes from — a one-line notice, kept apart from the person's own words.
 * @param todos - the unfinished plan.
 * @returns the reminder's source.
 */
function reminderSource(todos: readonly TodoItem[]): MessageSource {
  const left = todos.filter(item => item.status !== 'completed').length
  return { kind: 'tool-todo', form: 'notice', summary: `todo list: ${left} unfinished` }
}

/**
 * The steer sent when the agent tries to close a turn with its own plan unfinished. A question the
 * person sends mid-turn is spliced into the running turn; models answer it and stop, leaving the
 * plan behind with nothing saying so (measured on a customer session, 30/09/2026).
 * @param todos - the unfinished plan.
 * @returns the model-facing reminder.
 */
function reminder(todos: readonly TodoItem[]): string {
  const lines = todos.map(item => `- [${item.status}] ${item.content}`).join('\n')
  return 'Your todo list still has unfinished items:\n'
    + `${lines}\n`
    + 'If you answered something else in between, go back to the list now and continue with the next item, '
    + 'marking each item completed with todo_write as soon as it is done — including items you already finished. '
    + 'If the person changed their mind, or you cannot go on without them, update the list with todo_write '
    + 'so it shows what is true, and tell them what is left.'
}

/** The agent's current plan in one session, and whether this plan was already steered back to. */
interface OpenPlan {
  todos: TodoItem[]
  steered: boolean
}

/**
 * Register the `todo_write` tool on `ctx.tools` and the `todos` unit on
 * `ctx.sessionProjections`.
 * @param ctx - registrant context carrying the tool and session-projection registries.
 * @param config - deployment's explicit todo policy.
 */
export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress
  // Standing-plan fold: latest whole todo/write list. The next turn/start
  // clears a SETTLED plan (turn/end keeps the finished checklist visible) but
  // keeps one still in flight — any item in_progress — so a message sent while
  // a long-running job reports through this list does not blank it (Tracy
  // fork: a host-driven build writes its stages here, and the customer may
  // keep talking meanwhile). The agent's own plan is settled at turn/end, so
  // an abandoned item stops spinning. null before the first write; every
  // other event returns the same state reference.
  ctx.sessionProjections.register<'todos', TodoPlanState | null>({
    key: 'todos',
    stateSchema: todoPlanStateSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'todo/write') return { todos: event.data.todos, byAgent: event.data.by === 'agent' }
      if (event.type === 'turn/end') return settle(state)
      if (event.type === 'turn/start') return inFlight(state) ? state : null
      return state
    },
    wire: { viewSchema: todosProjectionSchema, view: state => state?.todos ?? null },
    stateVersion: 4,
  })

  // Tracy fork: steer the agent back to its own unfinished plan before the
  // turn closes — once per unchanged plan, so a model that stops again (it is
  // waiting for the person, or chose to) still ends the turn. A plan outlives
  // no turn: once the turn ends it is not raised again.
  const plans = new WeakMap<Session, OpenPlan>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'todo/write') {
      if (event.data.by === 'agent') plans.set(session, { todos: event.data.todos, steered: false })
      else plans.delete(session)
    } else if (event.type === 'turn/end') {
      plans.delete(session)
    }
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const plan = plans.get(agent.session)
    if (plan === undefined || plan.steered) return
    if (plan.todos.every(item => item.status === 'completed')) return
    plan.steered = true
    agent.steer(createUserMessage({ content: [{ type: 'text', text: reminder(plan.todos) }], source: reminderSource(plan.todos) }))
  })

  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              required: true,
              enum: [...STATUSES],
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: [...STATUSES] },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) {
        // The list is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      exec.agent.session.append('todo/write', { todos, by: 'agent' })
      const count = (status: TodoItem['status']): number => todos.filter(t => t.status === status).length
      return Promise.resolve({
        todos: todos.map(todo => ({ content: todo.content, status: todo.status })),
        counts: {
          pending: count('pending'),
          inProgress: count('in_progress'),
          completed: count('completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
  }))
}
