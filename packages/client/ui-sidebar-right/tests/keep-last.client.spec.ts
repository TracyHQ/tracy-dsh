/**
 * Tracy: a tab type that keeps its last tab (`SidebarRightTabDefinition.keepLast`).
 *
 * The workspace's own page — Tracy's site preview — must stay in its column:
 * the surface's last tab of such a kind refuses every explicit close, whoever
 * asks, while a second tab of the kind closes as any tab does. The answer is
 * read at each close, so a kind keeps its last tab only while it says so.
 */
import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { canCloseTab, createSidebarRightStore, keepsLastOf } from '../src/client/stores.ts'

const SESSION = 's-keep'
const KIND = 'site'

function harness(keep: { on: boolean } = { on: true }) {
  const instance = createSidebarRightStore(
    () => ({ kind: 'guide', title: 'Start' }),
    () => true,
    () => false,
    kind => kind === KIND && keep.on,
  ).create()
  instance.actions.open(SESSION)
  const surface = () => {
    const held = instance.getSnapshot().bySession[SESSION]
    if (held === undefined) throw new Error('expected a surface')
    return held
  }
  const open = (kind: string, path: string): TabId => {
    let landed: TabId | undefined
    instance.actions.openContent(SESSION, { kind, contentId: `https://example.test${path}`, title: path }, (id) => { landed = id })
    if (landed === undefined) throw new Error('expected the open to settle on a tab')
    return landed
  }
  return { actions: instance.actions, surface, open }
}

describe('keepLast — the surface\'s last tab of a kind that keeps it', () => {
  it('refuses the close, recording nothing, and the column stays open', () => {
    const { actions, surface, open } = harness()
    const site = open(KIND, '/')
    const before = surface()
    actions.closeTab(SESSION, site)
    expect(surface()).toBe(before)
    expect(surface().layout.tabs[site]).toBeDefined()
    expect(surface().layout.expanded).toBe(true)
  })

  it('closes a second tab of the kind, then keeps the one left', () => {
    const { actions, surface, open } = harness()
    const first = open(KIND, '/')
    const second = open(KIND, '/about')
    actions.closeTab(SESSION, first)
    expect(surface().layout.tabs[first]).toBeUndefined()
    actions.closeTab(SESSION, second)
    expect(surface().layout.tabs[second]).toBeDefined()
  })

  it('lets the other kinds around it close as before', () => {
    const { actions, surface, open } = harness()
    const site = open(KIND, '/')
    const other = open('text', '/notes.txt')
    actions.closeTab(SESSION, other)
    expect(surface().layout.tabs[other]).toBeUndefined()
    expect(surface().layout.tabs[site]).toBeDefined()
  })

  it('is read at each close: a kind that stops keeping closes its last tab', () => {
    const keep = { on: true }
    const { actions, surface, open } = harness(keep)
    const site = open(KIND, '/')
    actions.closeTab(SESSION, site)
    expect(surface().layout.tabs[site]).toBeDefined()
    keep.on = false
    actions.closeTab(SESSION, site)
    expect(surface().layout.tabs[site]).toBeUndefined()
  })

  it('leaves collapsing the column allowed', () => {
    const { actions, surface, open } = harness()
    const site = open(KIND, '/')
    actions.setExpanded(SESSION, false)
    expect(surface().layout.expanded).toBe(false)
    expect(surface().layout.tabs[site]).toBeDefined()
  })
})

describe('canCloseTab and keepsLastOf', () => {
  it('answers the same question the store asks, for the kit\'s close routes', () => {
    const { surface, open } = harness()
    const first = open(KIND, '/')
    const keeps = (kind: string) => kind === KIND
    expect(canCloseTab(surface(), first, keeps)).toBe(false)
    // Without a predicate nothing is kept — the upstream rule.
    expect(canCloseTab(surface(), first)).toBe(true)
    const second = open(KIND, '/about')
    expect(canCloseTab(surface(), first, keeps)).toBe(true)
    expect(canCloseTab(surface(), second, keeps)).toBe(true)
    expect(canCloseTab(surface(), 'missing' as TabId, keeps)).toBe(false)
  })

  it('reads the type in force, and a type that declares nothing keeps nothing', () => {
    const types: Record<string, { keepLast?: () => boolean }> = {
      site: { keepLast: () => true },
      paused: { keepLast: () => false },
      plain: {},
    }
    const keeps = keepsLastOf(kind => types[kind])
    expect(keeps('site')).toBe(true)
    expect(keeps('paused')).toBe(false)
    expect(keeps('plain')).toBe(false)
    expect(keeps('unregistered')).toBe(false)
  })
})
