// @vitest-environment jsdom
/**
 * Fenced-block folds: a registered fence renders as one chip in every
 * projection of the same text, and an unregistered fence, a fold that
 * declines, or a fold that throws leaves the raw text exactly as before.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { projectUserText } from '../src/user-text.tsx'
import { userTextFoldRanges, UserTextFoldsProvider, useUserTextFolds } from '../src/user-text-folds.ts'
import type { UserTextFold } from '../src/user-text-folds.ts'

const HINT = 'Model note: read the block above.'

/** A fold in the shape a plugin writes: reads one attribute, hides its fixed hint line. */
const noteFold: UserTextFold = {
  fence: 'note-block',
  fold(block, after) {
    const name = /name="([^"]*)"/u.exec(block)?.[1]
    if (name === undefined) return null
    const hint = /^\n([^\n]*)/u.exec(after)
    return {
      label: name,
      title: `about ${name}`,
      trailing: hint !== null && hint[1] === HINT ? hint[0].length : 0,
    }
  },
}

const turn = (request: string, body = '<el name="Services">\ntext: Services\n</el>') =>
  `${request}\n\n\`\`\`note-block\n${body}\n\`\`\`\n${HINT}`

const project = (text: string, folds: readonly UserTextFold[] = [noteFold]) =>
  render(<div data-host>{projectUserText(text, [], [], 'skill', undefined, folds)}</div>)
    .container.querySelector('[data-host]')!

describe('projectUserText with a fenced-block fold', () => {
  it('renders the raw block untouched when no fold is registered', () => {
    const text = turn('Make it bigger')
    const host = project(text, [])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe(text)
  })

  it('draws one chip in place of the block and hides the fold\'s hint line', () => {
    const host = project(turn('Make it bigger'))
    const chips = [...host.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(c => [c.getAttribute('data-ref-chip'), c.getAttribute('data-fold'), c.textContent]))
      .toEqual([['fold', 'note-block', 'Services']])
    expect(chips[0]!.getAttribute('title')).toBe('about Services')
    // The blank line collapses to one break: request, then the chip on its own line.
    expect(host.textContent).toBe('Make it bigger\nServices')
    expect(host.textContent).not.toContain('```')
    expect(host.textContent).not.toContain(HINT)
    expect(host.querySelectorAll('div').length).toBe(0)
  })

  it('folds a block whose body is empty', () => {
    const emptyBody: UserTextFold = { fence: 'note-block', fold: () => ({ label: 'image' }) }
    const text = 'Swap this\n\n```note-block\n```'
    expect(project(text, [emptyBody]).textContent).toBe('Swap this\nimage')
  })

  it('folds a block inside other text and keeps the text after it', () => {
    const text = `Before\n\n\`\`\`note-block\n<el name="Hero">\n\`\`\`\n${HINT}\nand after @notes.md`
    const host = project(text)
    expect([...host.querySelectorAll('[data-ref-chip]')].map(c => [c.getAttribute('data-ref-chip'), c.textContent]))
      .toEqual([['fold', 'Hero'], ['file', 'notes.md']])
    expect(host.textContent).toBe('Before\nHero\nand after notes.md')
  })

  it('does not decorate tokens inside a folded block', () => {
    const host = project(turn('Go', '<el name="X">\n@inside.md /skill'))
    expect([...host.querySelectorAll('[data-ref-chip]')].map(c => c.getAttribute('data-ref-chip'))).toEqual(['fold'])
  })

  it('leaves the block plain when the fold declines or throws', () => {
    const text = turn('Go', 'no name here')
    expect(project(text).textContent).toBe(text)
    const throwing: UserTextFold = { fence: 'note-block', fold: () => { throw new Error('bad block') } }
    expect(project(turn('Go'), [throwing]).textContent).toBe(turn('Go'))
  })

  it('ignores other fences and an unclosed block', () => {
    const other = 'See\n```js\nconst a = 1\n```'
    expect(project(other).textContent).toBe(other)
    const open = 'See\n```note-block\n<el name="X">'
    expect(project(open).textContent).toBe(open)
    const openWithNewline = 'See\n```note-block\n<el name="X">\n'
    expect(project(openWithNewline).textContent).toBe(openWithNewline)
  })

  it('closes a block only at a line of exactly three backticks', () => {
    const text = 'Go\n\n```note-block\n<el name="X">\n```js\n```'
    const host = project(text)
    expect(host.querySelector('[data-ref-chip="fold"]')!.textContent).toBe('X')
    expect(host.textContent).toBe('Go\nX')
  })

  it('renders an icon-only chip with its glyph', () => {
    const iconFold: UserTextFold = { fence: 'note-block', fold: () => ({ label: '', icon: <svg data-glyph /> }) }
    const host = project('```note-block\n```', [iconFold])
    const chip = host.querySelector('[data-ref-chip="fold"]')!
    expect(chip.querySelector('[data-glyph]')).not.toBeNull()
    // A block that opens the message starts no new line.
    expect(host.textContent).toBe('')
  })

  it('agrees on what is hidden for the same text in every projection', () => {
    // Echo, queue row and transcript all call projectUserText with the same folds.
    const text = turn('Make it bigger')
    const a = project(text).innerHTML
    const b = project(text).innerHTML
    expect(a).toBe(b)
  })
})

describe('userTextFoldRanges', () => {
  it('reports the span from the whitespace before the block through the hidden hint', () => {
    const text = turn('Hi')
    const [range] = userTextFoldRanges(text, [noteFold])
    expect(range).toMatchObject({ start: 2, end: text.length, lineBreak: true, fence: 'note-block' })
  })

  it('lets the first registration for a fence win', () => {
    const second: UserTextFold = { fence: 'note-block', fold: () => ({ label: 'second' }) }
    expect(userTextFoldRanges(turn('Hi'), [noteFold, second])[0]!.chip.label).toBe('Services')
  })

  it('returns nothing without folds or fences', () => {
    expect(userTextFoldRanges('plain', [noteFold])).toEqual([])
    expect(userTextFoldRanges(turn('Hi'), [])).toEqual([])
  })
})

describe('UserTextFoldsProvider', () => {
  it('hands the provided folds to useUserTextFolds and an empty list without one', () => {
    const Probe = () => <span data-count>{useUserTextFolds().length}</span>
    const bare = render(<Probe />)
    expect(bare.container.textContent).toBe('0')
    const provided = render(<UserTextFoldsProvider folds={[noteFold]}><Probe /></UserTextFoldsProvider>)
    expect(provided.container.textContent).toBe('1')
  })
})
