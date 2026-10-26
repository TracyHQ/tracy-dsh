/**
 * Normal column geometry. While the right column is open and the user has not
 * dragged the divider, the right column opens at the width its active tab
 * prefers (RIGHTBAR_PREFERRED unless the tab type names one) and the
 * Conversation (centre) takes the rest, never below CHAT_DEFAULT_MIN.
 *
 * Tracy (14/10/2026, Akemi): the frame no longer passes a tab's preferred
 * width (AppFrame.tsx), and RIGHTBAR_PREFERRED has no bound, so the
 * Conversation opens at CHAT_DEFAULT_MIN on every tab and the right column
 * takes everything else, as in Claude Design. The `preferred` parameters stay
 * so a caller can still price a narrower panel. A dragged
 * Conversation width is a px preference instead, clamped so the right column
 * stays between RIGHTBAR_DRAG_MIN and the larger of RIGHTBAR_MAX_RATIO of the
 * frame and its default width. The right column loses its track, rather than
 * squeezing the Conversation, once the rest is narrower than RIGHTBAR_MIN. The
 * sidebar never concedes here; AppFrame supplies its effective preference after
 * responsive collapse.
 *
 * Tracy: an active tab type may also name a ceiling for the right column. It
 * bounds the default and the drag range from above and is applied on every
 * read, so the Conversation width the user chose for other tabs is kept.
 */

/** Resolved widths for one frame. */
export interface Columns { sidebar: number; center: number; rightbar: number }

/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Right column floor: below it the right column gives up its track. */
export const RIGHTBAR_MIN = 300
/**
 * Right column width before any user drag. Tracy: no bound, so the right
 * column takes all the frame leaves after the Conversation's default width
 * (upstream: 1100, room for a site at desktop width).
 */
export const RIGHTBAR_PREFERRED = Number.POSITIVE_INFINITY
/** Right column floor for a divider drag: the width of a large phone, so the narrowest panel still previews a site. */
export const RIGHTBAR_DRAG_MIN = 430
/** Right column ceiling for a divider drag as a fraction of the frame, unless its default width is wider. */
export const RIGHTBAR_MAX_RATIO = 0.65
/** No ceiling on the right column: what every tab type that names no `maxWidth` gets. */
export const RIGHTBAR_NO_CEILING = Number.POSITIVE_INFINITY
/** Conversation width floor while the right column is open. */
export const CHAT_MIN = 250
/** Conversation width floor before any user drag, on frames wider than CHAT_COMPACT_FRAME. Tracy: 300 (upstream 360), the narrow chat column of Claude Design. */
export const CHAT_DEFAULT_MIN = 300
/** Frame width at or below which the default Conversation width is the floor. */
export const CHAT_COMPACT_FRAME = 814

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * The sidebar's track width for one preference.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param collapsedWidth - track width of the closed sidebar.
 * @returns the track width.
 */
export function sidebarTrack(sidebar: number, collapsedWidth = SIDEBAR_COLLAPSED): number {
  return sidebar === 0 ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
}

/**
 * The Conversation width before any user drag: the right column takes its
 * preferred width and the Conversation takes the rest.
 * @param viewport - frame width in px.
 * @param sidebar - sidebar track width in px.
 * @param preferred - the right column's preferred width in px.
 * @param ceiling - the widest the right column may be, in px.
 * @returns the rest of the frame, never below CHAT_DEFAULT_MIN; CHAT_MIN on a compact frame.
 */
export function chatDefault(viewport: number, sidebar: number, preferred = RIGHTBAR_PREFERRED, ceiling = RIGHTBAR_NO_CEILING): number {
  if (viewport <= CHAT_COMPACT_FRAME) return CHAT_MIN
  return Math.max(CHAT_DEFAULT_MIN, Math.round(viewport - sidebar - Math.min(preferred, ceiling)))
}

/**
 * The Conversation width range for a divider drag on one frame. The right
 * column keeps at least RIGHTBAR_DRAG_MIN and grows to at most the larger of
 * RIGHTBAR_MAX_RATIO of the frame and its default width, so grabbing the
 * divider never shrinks a panel that already opened wider than the ratio. A
 * ceiling bounds the right column below both.
 * @param viewport - frame width in px.
 * @param sidebar - sidebar track width in px.
 * @param preferred - the right column's preferred width in px.
 * @param ceiling - the widest the right column may be, in px.
 * @returns the range; `max` never falls below `min`, and `min` never below CHAT_MIN.
 */
export function chatRange(
  viewport: number, sidebar: number, preferred = RIGHTBAR_PREFERRED, ceiling = RIGHTBAR_NO_CEILING,
): { min: number; max: number } {
  const usable = viewport - sidebar
  const defaultRightbar = usable - chatDefault(viewport, sidebar, preferred, ceiling)
  const widest = Math.min(Math.max(Math.round(viewport * RIGHTBAR_MAX_RATIO), defaultRightbar), ceiling)
  const min = Math.max(CHAT_MIN, Math.round(usable - widest))
  return { min, max: Math.max(min, Math.round(usable - RIGHTBAR_DRAG_MIN)) }
}

/**
 * Clamp a Conversation width preference into the drag range of one frame.
 * @param px - requested width.
 * @param viewport - frame width in px.
 * @param sidebar - sidebar track width in px.
 * @param preferred - the right column's preferred width in px.
 * @param ceiling - the widest the right column may be, in px.
 * @returns the clamped width.
 */
export function clampChat(px: number, viewport: number, sidebar: number, preferred = RIGHTBAR_PREFERRED, ceiling = RIGHTBAR_NO_CEILING): number {
  const { min, max } = chatRange(viewport, sidebar, preferred, ceiling)
  return clampWidth(px, min, max)
}

/**
 * Solve the three column widths for one viewport frame.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param chat - Conversation width preference in px, or null when the right
 *   column takes no track (the Conversation then fills the rest).
 * @param collapsedWidth - track width of the closed sidebar; the default keeps
 *   the icon rail, 0 hides the column entirely (macOS desktop).
 * @param preferred - the right column's preferred width in px.
 * @param ceiling - the widest the right column may be, in px.
 * @returns actual widths; the right column is 0 when it has no track or the
 *   rest of the frame is narrower than RIGHTBAR_MIN.
 */
export function computeColumns(
  viewport: number, sidebar: number, chat: number | null, collapsedWidth = SIDEBAR_COLLAPSED, preferred = RIGHTBAR_PREFERRED,
  ceiling = RIGHTBAR_NO_CEILING,
): Columns {
  const s = sidebarTrack(sidebar, collapsedWidth)
  const alone = { sidebar: s, center: Math.max(0, viewport - s), rightbar: 0 }
  if (chat === null) return alone
  const center = clampChat(chat, viewport, s, preferred, ceiling)
  const rightbar = viewport - s - center
  return rightbar < RIGHTBAR_MIN ? alone : { sidebar: s, center, rightbar }
}
