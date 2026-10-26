// @vitest-environment jsdom
/** The current session on the address bar, under the page's base tag. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import { followAddress, holdsAddress, sessionInAddress, writeAddress } from '../src/client/url-state.ts'

function mountAt(href: string | undefined): void {
  document.head.replaceChildren()
  if (href === undefined) return
  const base = document.createElement('base')
  base.href = href
  document.head.append(base)
}

afterEach(() => {
  history.replaceState(null, '', '/')
  document.head.replaceChildren()
})

describe('session address', () => {
  it('names the session under the base and reads it back', () => {
    // Same origin as the jsdom page: history refuses a cross-origin address.
    mountAt('/site.example/')
    history.replaceState(null, '', '/site.example/')
    writeAddress('session-1' as SessionId, 'push')
    expect(location.pathname).toBe('/site.example/s/session-1')
    expect(sessionInAddress()).toBe('session-1')
    writeAddress(undefined, 'push')
    expect(location.pathname).toBe('/site.example/')
    expect(sessionInAddress()).toBeUndefined()
  })

  it('is the root shape when the page carries no base tag', () => {
    mountAt(undefined)
    writeAddress('session-2' as SessionId, 'replace')
    expect(location.pathname).toBe('/s/session-2')
    expect(sessionInAddress()).toBe('session-2')
  })

  it('does not read an asset-shaped or foreign path as a session', () => {
    mountAt(undefined)
    history.replaceState(null, '', '/s/missing.js')
    expect(sessionInAddress()).toBeUndefined()
    history.replaceState(null, '', '/other/s/session-3')
    expect(sessionInAddress()).toBeUndefined()
  })

  it('keeps query and hash, and writes nothing when the address already matches', () => {
    mountAt(undefined)
    history.replaceState(null, '', '/?fixture#x')
    const before = history.length
    writeAddress('session-4' as SessionId, 'push')
    expect(`${location.pathname}${location.search}${location.hash}`).toBe('/s/session-4?fixture#x')
    writeAddress('session-4' as SessionId, 'push')
    expect(history.length).toBe(before + 1)
  })

  it('hands Back and Forward the session the address names', async () => {
    mountAt(undefined)
    const seen: (SessionId | undefined)[] = []
    const stop = followAddress((id) => { seen.push(id) })
    writeAddress('session-5' as SessionId, 'push')
    writeAddress('session-6' as SessionId, 'push')
    history.back()
    await new Promise<void>((r) => { setTimeout(r, 20) })
    expect(seen.at(-1)).toBe('session-5')
    stop()
  })
})

// Tracy, 20/09/2026: the first mirror after boot used to correct the address to the bare base while
// `mainReference` was still undefined, then write `s/<id>` a beat later — measured on the dev host as
// `s/<id> → base → s/<id>` on every page a plugin had already named the session on. An address that
// names a LISTED session is not wrong; it is early. Hold it until the selection settles.
describe('holdsAddress', () => {
  const listed = (id: string): boolean => id === 'session-1'
  it('holds a not-yet-synced bar that names a listed session while nothing is selected yet', () => {
    expect(holdsAddress({ current: undefined, synced: false, addressed: 'session-1' as SessionId, listed })).toBe(true)
  })
  it('does not hold once a selection exists, once synced, or when the address names nothing', () => {
    expect(holdsAddress({ current: 'session-1' as SessionId, synced: false, addressed: 'session-1' as SessionId, listed })).toBe(false)
    expect(holdsAddress({ current: undefined, synced: true, addressed: 'session-1' as SessionId, listed })).toBe(false)
    expect(holdsAddress({ current: undefined, synced: false, addressed: undefined, listed })).toBe(false)
  })
  it('does not hold an address naming a session the list does not have — that one IS wrong and gets corrected', () => {
    expect(holdsAddress({ current: undefined, synced: false, addressed: 'session-gone' as SessionId, listed })).toBe(false)
  })
})
