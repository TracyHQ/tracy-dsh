import { describe, expect, it } from 'vitest'
import { chatDefault, chatRange, clampChat, clampWidth, computeColumns, sidebarTrack } from '../src/client/columns.ts'

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('sidebarTrack', () => {
  it('uses the collapsed width for a closed sidebar and clamps an open one', () => {
    expect(sidebarTrack(0)).toBe(56)
    expect(sidebarTrack(0, 0)).toBe(0)
    expect(sidebarTrack(9999)).toBe(420)
    expect(sidebarTrack(1)).toBe(264)
  })
})

describe('default Conversation width', () => {
  it('Tracy: opens the Conversation at 300px on any frame wider than 814px, the right panel taking the rest', () => {
    expect(chatDefault(1920, 56)).toBe(300)
    expect(chatDefault(2560, 56)).toBe(300)
    expect(chatDefault(1440, 280)).toBe(300)
  })

  it('leaves a bounded preferred right panel its width and gives the Conversation the rest', () => {
    expect(chatDefault(1920, 56, 1100)).toBe(764)
    expect(chatDefault(2560, 56, 1100)).toBe(1404)
  })

  it('leaves the right panel the width its active tab prefers', () => {
    expect(chatDefault(1920, 56, 600)).toBe(1264)
    expect(chatDefault(1440, 56, 600)).toBe(784)
  })

  it('Tracy: leaves the right panel at most its ceiling', () => {
    expect(chatDefault(1920, 56, 1100, 600)).toBe(1264)
    expect(chatDefault(1920, 56, 500, 600)).toBe(1364)
  })

  it('never goes below 300px, and is the 250px floor on a frame of 814px or less', () => {
    expect(chatDefault(1440, 56, 1100)).toBe(300)
    expect(chatDefault(815, 56)).toBe(300)
    expect(chatDefault(814, 56)).toBe(250)
  })
})

describe('Conversation drag range', () => {
  it('keeps the right panel between 430px and 65% of the frame', () => {
    expect(chatRange(1920, 56, 1100)).toEqual({ min: 616, max: 1434 })
    expect(chatRange(2560, 56, 600)).toEqual({ min: 840, max: 2074 })
  })

  it('lets the right panel keep a default width wider than 65% of the frame', () => {
    expect(chatRange(1440, 56)).toEqual({ min: 300, max: 954 })
    expect(chatRange(1280, 56)).toEqual({ min: 300, max: 794 })
    // Tracy: on a wide frame the default panel is wider than 65%, so the Conversation's default is its drag floor.
    expect(chatRange(1920, 56)).toEqual({ min: 300, max: 1434 })
  })

  it('never lets the range fall below 250px or cross itself', () => {
    expect(chatRange(700, 56)).toEqual({ min: 250, max: 250 })
    expect(chatRange(1024, 56)).toEqual({ min: 300, max: 538 })
  })

  it('Tracy: bounds the drag range from above by the right panel ceiling', () => {
    expect(chatRange(1920, 56, 600, 600)).toEqual({ min: 1264, max: 1434 })
    expect(chatRange(1920, 56, 1100, 600)).toEqual({ min: 1264, max: 1434 })
    // A ceiling under the 430px drag floor pins the panel at the ceiling.
    expect(chatRange(1920, 56, 1100, 400)).toEqual({ min: 1464, max: 1464 })
    expect(clampChat(1, 1920, 56, 1100, 600)).toBe(1264)
  })

  it('clamps a preference into the range and rounds', () => {
    expect(clampChat(1, 1920, 56, 1100)).toBe(616)
    expect(clampChat(9999, 1920, 56, 1100)).toBe(1434)
    expect(clampChat(800.6, 1920, 56, 1100)).toBe(801)
    expect(clampChat(1, 1920, 56)).toBe(300)
  })
})

describe('computeColumns', () => {
  it('gives the Conversation its preference and the right panel the rest', () => {
    expect(computeColumns(1920, 280, 700)).toEqual({ sidebar: 280, center: 700, rightbar: 940 })
    expect(computeColumns(1920, 0, 764)).toEqual({ sidebar: 56, center: 764, rightbar: 1100 })
  })

  it('lets the Conversation fill the frame when the right panel has no track', () => {
    expect(computeColumns(1920, 0, null)).toEqual({ sidebar: 56, center: 1864, rightbar: 0 })
    expect(computeColumns(1920, 280, null)).toEqual({ sidebar: 280, center: 1640, rightbar: 0 })
  })

  it('clamps the sidebar and the Conversation preferences', () => {
    expect(computeColumns(3000, 9999, 9999)).toEqual({ sidebar: 420, center: 2150, rightbar: 430 })
    expect(computeColumns(1920, 1, 1, 56, 1100)).toEqual({ sidebar: 264, center: 408, rightbar: 1248 })
    expect(computeColumns(1920, 1, 1)).toEqual({ sidebar: 264, center: 300, rightbar: 1356 })
  })

  it('keeps a dragged Conversation width when the frame resizes; the right panel absorbs it', () => {
    expect(computeColumns(2400, 0, 1000)).toEqual({ sidebar: 56, center: 1000, rightbar: 1344 })
    expect(computeColumns(1920, 0, 1000)).toEqual({ sidebar: 56, center: 1000, rightbar: 864 })
  })

  it('narrows a wide preference to leave the right panel 430px and restores it when the frame widens', () => {
    expect(computeColumns(1280, 0, 1000).center).toBe(794)
    expect(computeColumns(1920, 0, 1000).center).toBe(1000)
  })

  it('bounds the right panel by the width its active tab prefers', () => {
    expect(computeColumns(2560, 0, 9999, 56, 600)).toEqual({ sidebar: 56, center: 2074, rightbar: 430 })
    expect(computeColumns(2560, 0, 1, 56, 600)).toEqual({ sidebar: 56, center: 840, rightbar: 1664 })
  })

  it('Tracy: caps the right panel at a ceiling and keeps the stored Conversation width for other tabs', () => {
    // A Conversation preference that leaves the panel wider than the ceiling is read as the ceiling.
    expect(computeColumns(1920, 0, 400, 56, 1100, 600)).toEqual({ sidebar: 56, center: 1264, rightbar: 600 })
    // Without the ceiling the same preference gives the panel its width back.
    expect(computeColumns(1920, 0, 400)).toEqual({ sidebar: 56, center: 400, rightbar: 1464 })
    // Narrower than the ceiling still works.
    expect(computeColumns(1920, 0, 1400, 56, 1100, 600)).toEqual({ sidebar: 56, center: 1400, rightbar: 464 })
  })

  it.each([
    [1024, 420, 250, 354],
    [700, 0, 250, 394],
    [606, 0, 250, 300],
    [605, 0, 549, 0],
    [20, 0, 0, 0],
  ])('solves frame %i and sidebar %i to center %i and right %i', (viewport, sidebar, center, rightbar) => {
    expect(computeColumns(viewport, sidebar, 250)).toEqual({ sidebar: sidebar || 56, center, rightbar })
  })

  it('drops the right track rather than reduce a wide sidebar', () => {
    expect(computeColumns(900, 420, 250)).toEqual({ sidebar: 420, center: 480, rightbar: 0 })
  })
})
