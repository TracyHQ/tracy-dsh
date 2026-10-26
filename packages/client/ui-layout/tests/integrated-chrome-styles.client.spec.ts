/**
 * Tracy fork: the opt-in integrated macOS chrome row, asserted against the
 * stylesheets on disk. An embedding desktop shell marks
 * <html data-desktop-chrome="integrated">; the window's top row (traffic
 * lights, the conversation header's title row, the right panel's tab strip)
 * then reads as one strip on one tint, and everything below it is a card whose
 * edge starts at --dsh-chrome-height. Three packages own a piece of it: the
 * frame (ui-layout) owns the tint, the card and the column handles; the
 * conversation root (ui-conversation) stops painting over the strip; the
 * dockkit surface (ui-dockkit) fills its strip row to the chrome height and
 * paints its ground and edges only below it. Geometry itself is measured in the
 * embedding app (TCH tasks/evidence/desktop-titlebar-chrome/geometry.mjs).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT = resolve(import.meta.dirname, '../..')
const sheet = (file: string) => readFileSync(resolve(CLIENT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')

const FRAME = sheet('ui-layout/src/client/AppFrame.module.css')
const CONVERSATION = sheet('ui-conversation/src/client/skeleton/ConversationRoot.module.css')
const DOCKKIT = sheet('ui-dockkit/src/components/dockkit.module.css')
const SIDEBAR_RIGHT = sheet('ui-sidebar-right/src/client/shell/SidebarRight.module.css')

/** The mode's root selector, as authored in every sheet. */
const MODE = ":global(html[data-platform='darwin'][data-desktop-chrome='integrated'])"

/** Every rule of a sheet as [selector parts, declarations], ignoring at-rule nesting. */
function rules(css: string): { selectors: string[]; decls: Map<string, string> }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel = '', body = '']) => ({
    selectors: sel.split(',').map(part => part.replace(/\s+/g, ' ').trim()),
    decls: new Map(body.split(';').filter(part => part.includes(':')).map((part) => {
      const colon = part.indexOf(':')
      return [part.slice(0, colon).trim(), part.slice(colon + 1).replace(/\s+/g, ' ').trim()] as [string, string]
    })),
  }))
}

/** The declarations of the rule whose selector list contains `selector`, merged in source order. */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const merged = new Map<string, string>()
  for (const rule of rules(css)) if (rule.selectors.includes(selector)) for (const [k, v] of rule.decls) merged.set(k, v)
  return merged
}

describe('integrated macOS chrome (Tracy fork)', () => {
  it('scopes every rule of the mode to darwin, so the web and Windows never match it', () => {
    for (const css of [FRAME, CONVERSATION, DOCKKIT, SIDEBAR_RIGHT]) {
      const parts = rules(css).flatMap(rule => rule.selectors).filter(part => part.includes('data-desktop-chrome'))
      expect(parts.length).toBeGreaterThan(0)
      for (const part of parts) expect(part.startsWith(MODE)).toBe(true)
    }
  })

  it('publishes the chrome height and the content radius on the root element', () => {
    const root = declarationsOf(FRAME, MODE)
    expect(root.get('--dsh-chrome-height')).toBe('44px')
    expect(root.get('--dsh-content-radius')).toBe('12px')
  })

  it('paints one tint across the frame and leaves the sidebar column clear', () => {
    // The darwin sidebar tint, shared selector for selector: the washed rule for each theme, then
    // the Reduce Transparency fill (an @media block, so it is a later rule here).
    for (const frame of [`${MODE} .frame`, `${MODE} :global([data-ds-dark-theme]) .frame`]) {
      const backgrounds = rules(FRAME).filter(rule => rule.selectors.includes(frame)).map(rule => rule.decls.get('background'))
      expect(backgrounds).toHaveLength(2)
      expect(backgrounds[0]).toMatch(/^linear-gradient/)
      expect(backgrounds[1]).toMatch(/^color-mix/)
    }
    expect(declarationsOf(FRAME, `${MODE} .sidebarCol`).get('background')).toBe('transparent')
  })

  it('draws the content card below the strip with a rounded top-left corner', () => {
    const center = declarationsOf(FRAME, `${MODE} .centerCol`)
    expect(center.get('background')).toBe('transparent')
    expect(center.get('border-left')).toBe('none')
    expect(center.get('isolation')).toBe('isolate')
    const card = declarationsOf(FRAME, `${MODE} .centerCol::before`)
    expect(card.get('position')).toBe('absolute')
    expect(card.get('inset')).toBe('var(--dsh-chrome-height) 0 0 0')
    expect(card.get('z-index')).toBe('-1')
    expect(card.get('background')).toBe('var(--dsw-alias-bg-base)')
    expect(card.get('border-top-left-radius')).toBe('var(--dsh-content-radius)')
  })

  it('keeps the right track opaque only below the strip, and the column handles off it', () => {
    expect(declarationsOf(FRAME, `${MODE} .rightbarCol`).get('background'))
      .toBe('linear-gradient(var(--dsw-alias-bg-base) 0 0) 0 var(--dsh-chrome-height) / 100% 100% no-repeat')
    expect(declarationsOf(FRAME, `${MODE} .handle`).get('top')).toBe('var(--dsh-chrome-height)')
  })

  it('stops the conversation root from painting over the strip', () => {
    expect(declarationsOf(CONVERSATION, `${MODE} .root`).get('background')).toBe('transparent')
  })

  it('fills the dock strip row to the chrome height and grounds the dock below it', () => {
    // 10px top inset + the 28px band + this bottom inset = the chrome height.
    expect(declarationsOf(DOCKKIT, `${MODE} .tabHost:not(.float) .tabStrip`).get('padding-bottom')).toBe('calc(var(--dsh-chrome-height) - 38px)')
    expect(declarationsOf(DOCKKIT, `${MODE} .tabHost:not(.float)`).get('background'))
      .toBe('linear-gradient(var(--dsw-alias-bg-base) 0 0) 0 var(--dsh-chrome-height) / 100% 100% no-repeat')
    expect(declarationsOf(DOCKKIT, `${MODE} .tabCell[data-dockkit-host='dock'][data-dockkit-column='0'] > .tabHost`).get('border-left')).toBe('none')
    // The card's edges are borders of the pane body, which starts at the chrome height: a body
    // whose content paints opaque from its first pixel (a site preview, a file view) cannot cover
    // them, as it would a line painted into the host's background.
    expect(declarationsOf(DOCKKIT, `${MODE} .tabHost:not(.float) > .tabHostBody`).get('border-top')).toBe('0.5px solid var(--dsw-alias-border-l3)')
    expect(declarationsOf(DOCKKIT, `${MODE} .tabCell[data-dockkit-host='dock'][data-dockkit-column='0'] > .tabHost > .tabHostBody`).get('border-left'))
      .toBe('0.5px solid var(--dsw-alias-border-l4)')
    expect(declarationsOf(DOCKKIT, `${MODE} .tabLayoutDivider::before`).get('top')).toBe('var(--dsh-chrome-height)')
    expect(declarationsOf(DOCKKIT, `${MODE} .tabLayoutDivider::after`).get('top')).toBe('var(--dsh-chrome-height)')
  })

  it('keeps a fullscreen right panel opaque over the strip, since it covers the conversation header', () => {
    const pane = declarationsOf(SIDEBAR_RIGHT, `${MODE} .panel[data-sidebar-right-panel='fullscreen'] :global([data-dockkit-host='dock'][data-dockkit-column]) > :global([data-dockkit-pane])`)
    expect(pane.get('background')).toBe('var(--dsw-alias-bg-base)')
  })
})
