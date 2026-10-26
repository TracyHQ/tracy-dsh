// @vitest-environment jsdom
// Tracy: a reply that quotes prices ("$49 per month and $99 per year") rendered the text between the two dollar signs as
// one KaTeX formula, in italics and without spaces. A single dollar now opens inline math only when it reads as TeX the
// way Pandoc reads it: the opening dollar is followed by a non-space, the closing one follows a non-space and is not
// followed by a digit. Anything else stays text.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

const settled = (text: string) => render(<MarkdownText text={text} />).container

describe('MarkdownText dollar amounts', () => {
  it('keeps prices as text', () => {
    for (const text of [
      'The Starter plan is $49 per month and the Pro plan is $99 per month.',
      'Plans: $49/month or $99/month.',
      'Pick $5, $10 or $15.',
      'From $10-$20 a class.',
      'Between US$49 and US$99.',
      '- Basic: $29\n- Premium: $59',
      '| Plan | Price |\n| --- | --- |\n| Basic | $29 and $59 |',
    ]) {
      const container = settled(text)
      expect(container.querySelector('.katex'), text).toBeNull()
      expect(container.textContent?.replace(/\s+/g, ' '), text).toContain('$')
      cleanup()
    }
    expect(settled('Pay $49 per month and $99 per year.').textContent).toBe('Pay $49 per month and $99 per year.')
  })

  it('still renders inline TeX between single dollars', () => {
    for (const [text, value] of [
      ['Einstein wrote $E = mc^2$.', 'E = mc^2'],
      ['Inline $\\theta$ here.', '\\theta'],
      ['$x$ costs $5 today.', 'x'],
      ['Sum $a+b$, then $c$.', 'a+b'],
    ] as const) {
      const container = settled(text)
      expect(container.querySelector('annotation')?.textContent, text).toBe(value)
      cleanup()
    }
    expect(settled('Sum $a+b$, then $c$.').querySelectorAll('.katex')).toHaveLength(2)
  })

  it('leaves double-dollar math and escaped dollars as they were', () => {
    expect(settled('$$x$$ trailing').querySelector('annotation')?.textContent).toBe('x')
    cleanup()
    const escaped = settled('Costs \\$5 and \\$6.')
    expect(escaped.querySelector('.katex')).toBeNull()
    expect(escaped.textContent).toBe('Costs $5 and $6.')
  })
})
