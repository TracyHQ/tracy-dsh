import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const approvalCss = readFileSync(fileURLToPath(new URL(
  '../src/client/ApprovalPanel.module.css',
  import.meta.url,
)), 'utf8')

/** Return the first rule body for an exact class selector. */
function rule(css: string, selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 's').exec(css)
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

// The conversation column beside a side panel is as narrow as 250px, where
// Reject and Allow once no longer fit on one row of the card.
describe('approval panel in a narrow conversation column', () => {
  it('wraps its buttons instead of clipping them', () => {
    const row = rule(approvalCss, '.actionRow')
    expect(row).toMatch(/flex-wrap:\s*wrap/)
    expect(row).toMatch(/justify-content:\s*flex-end/)
  })

  it('gives the card the root\'s extra side width in the narrowest seats', () => {
    expect(rule(approvalCss, '.root')).toMatch(/container-type:\s*inline-size/)
    // A container query cannot restyle its container, so the card spends the
    // root's 16px per side; the block comes after the base .card rule it overrides.
    const narrow = /@container \(max-width: 480px\)\s*\{\s*\.card\s*\{([^}]*)\}/s.exec(approvalCss)
    expect(narrow, 'missing narrow .card rule').not.toBeNull()
    expect(narrow?.[1]).toMatch(/margin-inline:\s*-16px/)
    expect(approvalCss.indexOf('@container (max-width: 480px)')).toBeGreaterThan(approvalCss.indexOf('.card {'))
  })
})
