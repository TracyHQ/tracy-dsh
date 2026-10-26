// @vitest-environment jsdom
/**
 * A remote (non-loopback) browser keeps its settings forms in memory mode and
 * never writes the host-wide document, so the Appearance and font-size
 * choices persist per browser in localStorage instead. Host (loopback) mode
 * keeps its Host-document path and never touches localStorage.
 */
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { bootThemeInjections } from '../src/boot-theme.ts'
import { THEME_LOCAL_STORAGE_KEY, THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema } from '../src/theme-settings.ts'

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

/** Boot one theme runtime the way a page load does, over a fake Host. */
async function bootRuntime(isLoopback: boolean) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const section: Record<string, unknown> = { preference: 'system', fontSize: 14 }
  const namespace = () => ({
    ns: THEME_SETTINGS_NAMESPACE,
    schema: ThemeSettingsSchema.toJSON(),
    value: { ...section },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  })
  const describeCall = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [namespace()] },
  }))
  const mutate = vi.fn((_ns: string, ops: { path: string[]; value: unknown }[]) => {
    const op = ops[0]!
    section[op.path[0]!] = op.value
    return Promise.resolve({ ok: true as const, value: namespace() })
  })
  const remote = new TestRemote(ctx, { settings: { describe: describeCall, mutate } })
  remote.$host = { home: undefined, isLoopback }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { theme: ctx.get('theme') as ThemeRuntime, mutate }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('remote browser (memory mode)', () => {
  it('keeps Light across a reload', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const first = await bootRuntime(false)
    first.theme.setTheme('light')
    const reloaded = await bootRuntime(false)
    expect(reloaded.theme.getTheme().preference).toBe('light')
    expect(first.mutate).not.toHaveBeenCalled()
  })

  it('keeps Dark and the font size across a reload', async () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const first = await bootRuntime(false)
    first.theme.setTheme('dark')
    first.theme.setFontSize(16)
    const reloaded = await bootRuntime(false)
    expect(reloaded.theme.getTheme()).toMatchObject({ preference: 'dark', fontSize: 16 })
  })

  it('ignores a corrupt or out-of-range stored value', async () => {
    vi.stubGlobal('localStorage', fakeStorage({
      [THEME_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: 'sepia', fontSize: 99 }),
    }))
    const { theme } = await bootRuntime(false)
    expect(theme.getTheme()).toMatchObject({ preference: 'system', fontSize: 14 })
    for (const raw of ['{not json', '5', 'null']) {
      vi.stubGlobal('localStorage', fakeStorage({ [THEME_LOCAL_STORAGE_KEY]: raw }))
      const again = await bootRuntime(false)
      expect(again.theme.getTheme().preference).toBe('system')
    }
  })

  it('falls back to system and never throws when storage is blocked', async () => {
    const blocked = {
      getItem: vi.fn(() => { throw new Error('SecurityError') }),
      setItem: vi.fn(() => { throw new Error('QuotaExceededError') }),
    }
    vi.stubGlobal('localStorage', blocked)
    const { theme } = await bootRuntime(false)
    expect(theme.getTheme().preference).toBe('system')
    expect(() => { theme.setTheme('light') }).not.toThrow()
    expect(theme.getTheme().preference).toBe('light')
    vi.stubGlobal('localStorage', null)
    const missing = await bootRuntime(false)
    expect(() => { missing.theme.setTheme('dark') }).not.toThrow()
  })

  it('falls back to system when reading the localStorage property itself throws', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('SecurityError') },
    })
    try {
      const { theme } = await bootRuntime(false)
      expect(theme.getTheme().preference).toBe('system')
      expect(() => { theme.setFontSize(15) }).not.toThrow()
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
      else Object.defineProperty(globalThis, 'localStorage', original)
    }
  })
})

describe('loopback browser (host mode)', () => {
  it('writes the Host document and never touches localStorage', async () => {
    const storage = fakeStorage({ [THEME_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: 'dark', fontSize: 16 }) })
    vi.stubGlobal('localStorage', storage)
    const { theme, mutate } = await bootRuntime(true)
    expect(theme.getTheme().preference).not.toBe('dark')
    theme.setTheme('light')
    theme.setFontSize(15)
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalled() })
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})

describe('boot script (pre-paint)', () => {
  const DARK = 'data-ds-dark-theme'

  afterEach(() => {
    delete document.documentElement.dataset.dsThemeSource
    document.body.removeAttribute(DARK)
    document.body.style.removeProperty('--dsh-content-font-size')
    for (const node of document.head.querySelectorAll('style[data-dsh-boot-theme]')) node.remove()
  })

  function runBoot(hostname: string, storage: unknown, systemDark = true): void {
    const matchMedia = vi.fn(() => ({ matches: systemDark }) as MediaQueryList)
    for (const row of bootThemeInjections('system', 14)) {
      if (row.kind === 'script') runInNewContext(row.text, { document, matchMedia, location: { hostname }, localStorage: storage })
    }
  }

  it('applies the stored Light on a remote host before plugins run', () => {
    runBoot('cowork.tracy.site', fakeStorage({
      [THEME_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: 'light', fontSize: 16 }),
    }))
    expect(document.documentElement.dataset.dsThemeSource).toBe('light')
    expect(document.body.hasAttribute(DARK)).toBe(false)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
    const style = document.head.querySelector('style[data-dsh-boot-theme]')
    expect(style?.textContent).toContain(':root{color-scheme:light}')
  })

  it('keeps the server preference on a loopback host without reading storage', () => {
    const storage = fakeStorage({ [THEME_LOCAL_STORAGE_KEY]: JSON.stringify({ preference: 'light', fontSize: 16 }) })
    runBoot('127.0.0.1', storage)
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
    expect(document.body.hasAttribute(DARK)).toBe(true)
  })

  it('keeps the server preference when storage is blocked or missing', () => {
    runBoot('cowork.tracy.site', { getItem: () => { throw new Error('SecurityError') } })
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
    expect(document.body.hasAttribute(DARK)).toBe(true)
    runBoot('cowork.tracy.site', undefined)
    expect(document.documentElement.dataset.dsThemeSource).toBe('system')
  })
})
