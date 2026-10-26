import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Read one stylesheet of this package's client sources. */
function sheet(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/client/${name}`, import.meta.url)), 'utf8')
}

/** Return the first rule body for an exact class selector. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 's').exec(css)
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

/** Return the text of one `@container` block, braces balanced. */
function containerBlock(css: string, query: string): string {
  const start = css.indexOf(`@container ${query}`)
  expect(start, `missing @container ${query}`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(open + 1, index)
  }
  return ''
}

// The conversation column beside a side panel is as narrow as 250px on a wide
// window, so the takeover sizes its compact layout by its own seat, never by
// the viewport, and no action row may clip a button out of the card.
describe.each([
  { file: 'QuestionComposer.module.css', actions: '.footerActions' },
  { file: 'PlanReviewPanel.module.css', actions: '.actions' },
])('$file in a narrow conversation column', ({ file, actions }) => {
  const css = sheet(file)

  it('sizes against its own seat', () => {
    expect(rule(css, '.frame')).toMatch(/container-type:\s*inline-size/)
    expect(css).not.toMatch(/@media\s*\(max-width/)
    expect(css).toContain('@container (max-width: 720px)')
  })

  it('wraps the actions below the footer instead of clipping them', () => {
    expect(rule(css, '.footer')).toMatch(/flex-wrap:\s*wrap/)
    const row = rule(css, actions)
    expect(row).toMatch(/margin-left:\s*auto/)
    expect(row).toMatch(/flex-wrap:\s*wrap/)
  })

  it('gives the card the frame\'s extra side width in the narrowest seats', () => {
    const narrow = containerBlock(css, '(max-width: 480px)')
    // A container query cannot restyle its container, so the card (a child of
    // .frame) spends the frame's 16px per side through negative margins.
    expect(narrow).not.toMatch(/\.frame\s*\{/)
    const card = rule(narrow, '.card')
    expect(card).toMatch(/width:\s*calc\(100% \+ 32px\)/)
    expect(card).toMatch(/margin-inline:\s*-16px/)
  })
})

describe('QuestionComposer.module.css height in a narrow seat', () => {
  it('lets the card take more of a short viewport where the column is narrow', () => {
    const narrow = containerBlock(sheet('QuestionComposer.module.css'), '(max-width: 480px)')
    expect(rule(narrow, '.card')).toMatch(/max-height:\s*min\(75vh,\s*520px\)/)
  })
})
