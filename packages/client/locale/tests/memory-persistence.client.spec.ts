// @vitest-environment jsdom
/**
 * A remote (non-loopback) browser keeps its settings forms in memory mode and
 * never writes the host-wide document, so the Language choice persists per
 * browser in localStorage instead (TRACY FORK, same model as ui-theme's
 * `dsh.ui-theme.v1`). Host (loopback) mode keeps its Host-document path and
 * never touches localStorage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { LocaleSettings } from '@deepseek-ai/dsh-client-locale/client'
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
  const runtime = new LocaleRuntime(new Context(), form.scope)
  return { runtime, form }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('remote browser (memory mode)', () => {
  it('keeps the chosen language across a reload', () => {
    stubLanguages('en-US')
    vi.stubGlobal('localStorage', fakeStorage())
    boot('memory').runtime.setLocale('zh')
    expect(boot('memory').runtime.getLocale().active).toBe('zh')
  })

  it('keeps a language-pack choice that registers after the page boots', () => {
    stubLanguages('en-US')
    vi.stubGlobal('localStorage', fakeStorage({ [LOCALE_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: 'vi' }) }))
    const { runtime } = boot('memory')
    expect(runtime.getLocale().active).toBe('en')
    runtime.addLanguage({ id: 'vi', label: 'Tiếng Việt', fallback: 'en' })
    expect(runtime.getLocale().active).toBe('vi')
  })

  it('falls back to the browser language when the stored language is never registered', () => {
    stubLanguages('zh-CN')
    vi.stubGlobal('localStorage', fakeStorage({ [LOCALE_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: 'ar' }) }))
    expect(boot('memory').runtime.getLocale().active).toBe('zh')
  })

  it('reads corrupt, malformed or blocked storage as nothing stored', () => {
    stubLanguages('en-US')
    vi.stubGlobal('localStorage', fakeStorage({ [LOCALE_LOCAL_STORAGE_KEY]: '{not json' }))
    expect(boot('memory').runtime.getLocale().active).toBe('en')
    vi.stubGlobal('localStorage', fakeStorage({ [LOCALE_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: '<script>' }) }))
    expect(boot('memory').runtime.getLocale().active).toBe('en')
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
    })
    const { runtime } = boot('memory')
    expect(() => { runtime.setLocale('zh') }).not.toThrow()
    expect(runtime.getLocale().active).toBe('zh')
  })
})

describe('loopback browser (host mode)', () => {
  it('writes through the Host scope and never touches localStorage', () => {
    stubLanguages('en-US')
    const store = fakeStorage()
    vi.stubGlobal('localStorage', store)
    const { runtime, form } = boot('host')
    runtime.setLocale('zh')
    expect(form.set).toHaveBeenCalledWith('preference', 'zh')
    expect(store.getItem).not.toHaveBeenCalled()
    expect(store.setItem).not.toHaveBeenCalled()
  })
})
