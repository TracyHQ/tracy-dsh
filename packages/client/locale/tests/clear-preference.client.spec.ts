// @vitest-environment jsdom
/**
 * `clearPreference` drops the explicit Language choice so the UI follows the
 * browser's language list again (TRACY FORK, the "follow device" choice), and
 * the snapshot says whether a choice stands (`preference`). Host (loopback)
 * mode unsets the Host field; memory (remote) mode removes the browser's
 * stored choice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { LocaleSettings, LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LOCALE_LOCAL_STORAGE_KEY } from '../src/locale-settings.ts'

/** Map-backed Storage double whose methods are spies. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }),
  }
}

const stubLanguages = (...tags: string[]): void => {
  vi.stubGlobal('navigator', { languages: tags, language: tags[0] ?? '' })
}

/** Boot one runtime the way a page load does, over a scope in the given mode. */
function boot(mode: 'host' | 'memory') {
  const form = stubConfigForm<LocaleSettings>()
  if (mode === 'memory') form.publish({ mode: 'memory', status: 'unavailable' })
  const ctx = new Context()
  const events: LocaleSnapshot[] = []
  ctx.on('locale/change', (snapshot) => { events.push(snapshot) })
  const runtime = new LocaleRuntime(ctx, form.scope)
  return { runtime, form, events }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('snapshot preference', () => {
  it('is absent until a language is chosen, then names it', () => {
    stubLanguages('en-US')
    const { runtime } = boot('host')
    expect(runtime.getLocale().preference).toBeUndefined()
    runtime.setLocale('zh')
    expect(runtime.getLocale().preference).toBe('zh')
  })

  it('a first explicit pick of the language on screen republishes, without a locale change event', () => {
    stubLanguages('en-US')
    const { runtime, events } = boot('host')
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.setLocale('en')
    expect(runtime.getLocale()).toMatchObject({ active: 'en', preference: 'en' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(0)
  })

  it('follows a Host document that gains or loses the field', () => {
    stubLanguages('en-US')
    const { runtime, form } = boot('host')
    form.publish({ status: 'ready', value: { preference: 'en' }, revision: 1, writable: true })
    expect(runtime.getLocale().preference).toBe('en')
    form.publish({ value: {}, revision: 2 })
    expect(runtime.getLocale().preference).toBeUndefined()
  })
})

describe('clearPreference in host (loopback) mode', () => {
  it('unsets the Host field and returns to the browser language', () => {
    stubLanguages('zh-CN')
    const store = fakeStorage()
    vi.stubGlobal('localStorage', store)
    const { runtime, form, events } = boot('host')
    runtime.setLocale('en')
    expect(runtime.getLocale().active).toBe('en')
    runtime.clearPreference()
    expect(form.unset).toHaveBeenCalledWith('preference')
    expect(runtime.getLocale()).toMatchObject({ active: 'zh' })
    expect(runtime.getLocale().preference).toBeUndefined()
    expect(events.map(snapshot => snapshot.active)).toEqual(['en', 'zh'])
    expect(store.removeItem).not.toHaveBeenCalled()
  })

  it('republishes even when the browser language was already on screen', () => {
    stubLanguages('en-US')
    const { runtime, events } = boot('host')
    runtime.setLocale('en')
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.clearPreference()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(runtime.getLocale().preference).toBeUndefined()
    expect(events).toHaveLength(0)
  })

  it('still unsets when nothing is chosen in this page, without churning subscribers', () => {
    stubLanguages('en-US')
    const { runtime, form } = boot('host')
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.clearPreference()
    expect(form.unset).toHaveBeenCalledWith('preference')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('clearPreference in memory (remote) mode', () => {
  it('removes the stored choice, so a reload follows the browser language', () => {
    stubLanguages('en-US')
    const store = fakeStorage()
    vi.stubGlobal('localStorage', store)
    const first = boot('memory').runtime
    first.setLocale('zh')
    expect(store.data.has(LOCALE_LOCAL_STORAGE_KEY)).toBe(true)
    expect(boot('memory').runtime.getLocale()).toMatchObject({ active: 'zh', preference: 'zh' })

    first.clearPreference()
    expect(first.getLocale().active).toBe('en')
    expect(store.data.has(LOCALE_LOCAL_STORAGE_KEY)).toBe(false)
    const reloaded = boot('memory').runtime.getLocale()
    expect(reloaded.active).toBe('en')
    expect(reloaded.preference).toBeUndefined()
  })

  it('clears a stored language still waiting for its pack, so the pack no longer takes over', () => {
    stubLanguages('en-US')
    vi.stubGlobal('localStorage', fakeStorage({ [LOCALE_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: 'vi' }) }))
    const { runtime } = boot('memory')
    expect(runtime.getLocale()).toMatchObject({ active: 'en', preference: 'vi' })
    runtime.clearPreference()
    runtime.addLanguage({ id: 'vi', label: 'Tiếng Việt', fallback: 'en' })
    expect(runtime.getLocale().active).toBe('en')
  })

  it('drops a blocked store silently', () => {
    stubLanguages('en-US')
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('SecurityError') },
      removeItem: () => { throw new Error('SecurityError') },
    })
    const { runtime } = boot('memory')
    runtime.setLocale('zh')
    expect(() => { runtime.clearPreference() }).not.toThrow()
    expect(runtime.getLocale().active).toBe('en')
  })
})
