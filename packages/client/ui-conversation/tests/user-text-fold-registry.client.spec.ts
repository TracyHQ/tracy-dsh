/**
 * The root registry of fenced-block folds: one fold per fence, owned by the
 * registering context's lifetime, observable through `source`.
 */
import { Context } from '@deepseek-ai/cordis'
import type { UserTextFold } from '@deepseek-ai/dsh-client-ui-primitives'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { UserTextFoldRegistry } from '../src/client/conversation/user-text-fold-registry.ts'

const fold = (fence: string): UserTextFold => ({ fence, fold: () => ({ label: fence }) })

describe('UserTextFoldRegistry', () => {
  it('publishes registrations through source and retires them on dispose or context end', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const registry = new UserTextFoldRegistry(ctx)
    const changed = vi.fn()
    const unsubscribe = registry.source.subscribe(changed)
    expect(registry.source.getSnapshot()).toEqual([])
    const a = fold('a-block')
    const dispose = registry.register(a)
    expect(registry.source.getSnapshot()).toEqual([a])
    expect(() => registry.register(fold('a-block'))).toThrow('already registered')
    dispose()
    dispose()
    expect(registry.source.getSnapshot()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    unsubscribe()
    registry.register(fold('b-block'))
    await ctx.fiber.dispose()
    expect(registry.source.getSnapshot()).toEqual([])
  })
})
