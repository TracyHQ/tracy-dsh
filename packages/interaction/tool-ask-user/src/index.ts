/**
 * Model-facing Consumer of the `ctx.userQuestions` capability seam.
 * The tool pauses until a UI provider returns a human answer, then feeds that
 * answer back into the agent loop as an ordinary tool result.
 *
 * @module @deepseek-ai/dsh-tool-ask-user
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { registerTimedAskUser } from './timed.ts'
import '@deepseek-ai/dsh-user-questions'

/** Cordis row selecting the tool schema and its default foreground wait. */
export interface Config {
  /** Tool definition selected by this Cordis row. Defaults to the blocking legacy tool. */
  mode?: 'legacy' | 'timed'
  /** Foreground wait before automatic continuation. Defaults to 120 seconds. */
  timeout?: number
}

export const Config: z<Config> = z.object({
  mode: z.union(['legacy', 'timed']).default('legacy'),
  timeout: z.union([-1, z.number().step(1).min(1).max(2_147_483)]).default(120),
})

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const description = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding.'

/** The tool result as the model reads it: the answer JSON, plus what the human's choice of action asks of it. */
interface AnswerView {
  answers: { id: string; selected: string[]; custom?: string }[]
  action?: string
  note?: string
}

/**
 * Render the answer for the model. A plain submit stays the bare JSON; a
 * `follow_up` or `decide` adds one line saying what the human expects next, so
 * the model does not have to infer it from the shape of the answers.
 */
function renderAnswer(asked: readonly { id: string }[], value: AnswerView): string {
  const json = JSON.stringify(value)
  if (value.action === 'follow_up') {
    return `${json}\nThe customer asked for follow-up questions before deciding; `
      + 'ask only what is new, do not repeat answered questions.'
  }
  if (value.action === 'decide') {
    // A question counts as left to the model when its answer is empty or the
    // answerer did not return it at all.
    const answered = new Set(value.answers
      .filter(answer => answer.selected.length > 0 || answer.custom !== undefined)
      .map(answer => answer.id))
    const left = asked.map(question => question.id).filter(id => !answered.has(id))
    return left.length === 0
      ? json
      : `${json}\nThe customer left the unanswered questions to you: ${left.join(', ')}`
  }
  return json
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.mode === 'timed') {
    registerTimedAskUser(ctx, config.timeout)
    return
  }
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
            recommended: {
              type: 'string',
              description: 'Label of the option you would pick yourself; it is shown as the default. It must equal one option\'s label exactly; do not add a suffix such as "(Recommended)" to labels.',
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
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
          action: { type: 'string', enum: ['submit', 'decide', 'follow_up'] },
          note: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderAnswer(args.questions, value) }],
    },
    async execute(args, exec) {
      const result = await ctx.userQuestions.ask({
        questions: args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header !== undefined ? { header: question.header } : {},
          ...question.options !== undefined ? { options: question.options } : {},
          ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
          ...question.recommended !== undefined ? { recommended: question.recommended } : {},
        })),
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        signal: exec.signal,
      })
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
        ...result.action !== undefined ? { action: result.action } : {},
        ...result.note !== undefined ? { note: result.note } : {},
      }
    },
  }))
}
