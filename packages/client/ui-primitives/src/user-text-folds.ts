/**
 * Fenced-block folds for sent user text: a plugin that sends a machine-read
 * fenced block inside a user message (a descriptor the model reads, say)
 * registers the block's fence name and a fold; every surface that projects
 * user text (transcript bubble, submission echo, queue rows) then draws one
 * chip in the block's place instead of the raw fenced lines. The wire text is
 * untouched — this is presentation only, like the rest of `projectUserText`.
 *
 * The contract is deliberately small and knows no plugin grammar:
 * - a block is a line that opens with three backticks directly followed by
 *   the registered fence name, up to the next line that is exactly three
 *   backticks (the body may be empty);
 * - the fold receives the whole block (fence lines included) and the text
 *   after its closing fence, and answers a chip or null (null = the block
 *   stays plain text);
 * - `trailing` lets the chip also cover the start of the text after the block
 *   (a fixed line the plugin appends for the model), counted in UTF-16 code
 *   units of `after`;
 * - blank space around a folded block collapses: the chip takes the block's
 *   place on its own line after any preceding text, and whitespace left at
 *   the end of the message is dropped.
 *
 * The registry that holds folds at runtime is owned by a Cordis service (see
 * ui-conversation's `uiConversation.userTextFolds`): client bundles each carry
 * their own copy of this package, so module state here would not be shared.
 * Consumers read the live list from that service and hand it to
 * `projectUserText`, or provide it to a subtree through
 * {@link UserTextFoldsProvider}.
 */
import { createContext, createElement, useContext } from 'react'
import type { ReactNode } from 'react'

/** The chip one fold answers for one block. */
export interface UserTextFoldChip {
  /** Chip words. May be empty when `icon` carries the meaning alone. */
  readonly label: string
  /** Hover text; defaults to `label`. */
  readonly title?: string
  /** Optional leading glyph, sized to the surrounding text (1em). */
  readonly icon?: ReactNode
  /** How many leading UTF-16 code units of `after` the chip also hides. */
  readonly trailing?: number
}

/** One registered fold: the fence name it claims and its reader. */
export interface UserTextFold {
  /** Fence name after the opening backticks, e.g. `my-block` for three backticks then `my-block`. */
  readonly fence: string
  /**
   * Read one block.
   * @param block - the block text from its opening backticks through its closing backticks.
   * @param after - the message text after the closing backticks.
   * @returns the chip to draw, or null to leave the block as plain text.
   */
  fold(block: string, after: string): UserTextFoldChip | null
}

/** One folded span of a message, resolved against the registered folds. */
export interface UserTextFoldRange {
  /** Start offset: the first whitespace character before the block, or the block start. */
  readonly start: number
  /** End offset (exclusive): after the block, its `trailing` text, and a whitespace-only tail. */
  readonly end: number
  /** Whether the chip starts its own line (anything precedes the span). */
  readonly lineBreak: boolean
  readonly fence: string
  readonly chip: UserTextFoldChip
}

const FENCE = '```'
const OPEN_RE = /(?:^|\n)```([^\s`]+)[^\S\n]*\n/gu

/**
 * Find the folded spans of one message.
 * @param text - the message text.
 * @param folds - registered folds; the first fold registered for a fence wins.
 * @returns non-overlapping spans in text order (empty when no fold applies).
 */
export function userTextFoldRanges(text: string, folds: readonly UserTextFold[]): UserTextFoldRange[] {
  if (folds.length === 0 || !text.includes(FENCE)) return []
  // Later entries overwrite earlier ones, so reversing keeps the first registration per fence.
  const byFence = new Map([...folds].reverse().map(fold => [fold.fence, fold] as const))
  const ranges: UserTextFoldRange[] = []
  OPEN_RE.lastIndex = 0
  let open: RegExpExecArray | null
  while ((open = OPEN_RE.exec(text)) !== null) {
    const fold = byFence.get(open[1] as string) // non-optional capture
    if (fold === undefined) continue
    const blockStart = open.index + (text[open.index] === '\n' ? 1 : 0)
    const bodyStart = open.index + open[0].length
    const closeAt = closingFence(text, bodyStart)
    if (closeAt < 0) continue
    const blockEnd = closeAt + FENCE.length
    const after = text.slice(blockEnd)
    let chip: UserTextFoldChip | null
    try {
      chip = fold.fold(text.slice(blockStart, blockEnd), after)
    } catch {
      // A throwing fold must not take the message down with it: the block stays plain.
      chip = null
    }
    if (chip === null) continue
    const trailing = Math.max(0, Math.min(after.length, Math.trunc(chip.trailing ?? 0)))
    let end = blockEnd + trailing
    if (text.slice(end).trim() === '') end = text.length
    let start = blockStart
    const floor = ranges.at(-1)?.end ?? 0
    while (start > floor && /\s/u.test(text[start - 1] as string)) start -= 1
    ranges.push({ start, end, lineBreak: start > 0, fence: fold.fence, chip })
    OPEN_RE.lastIndex = end
  }
  return ranges
}

/**
 * Offset of the closing fence line at or after `from`: a line that is exactly
 * three backticks, ending at a newline or the text end.
 */
function closingFence(text: string, from: number): number {
  let at = from
  while (at <= text.length - FENCE.length) {
    if (text.startsWith(FENCE, at)) {
      const next = at + FENCE.length
      if (next === text.length || text[next] === '\n') return at
    }
    const newline = text.indexOf('\n', at)
    if (newline < 0) return -1
    at = newline + 1
  }
  return -1
}

const NO_FOLDS: readonly UserTextFold[] = []
const UserTextFoldsContext = createContext<readonly UserTextFold[]>(NO_FOLDS)

/**
 * Provide the live fold list to every user-text projection below.
 * @param props - the fold list and the subtree.
 * @returns the provider element.
 */
export function UserTextFoldsProvider({ folds, children }: {
  folds: readonly UserTextFold[]
  children?: ReactNode
}): ReactNode {
  return createElement(UserTextFoldsContext.Provider, { value: folds }, children)
}

/**
 * Read the fold list a {@link UserTextFoldsProvider} above supplies.
 * @returns the provided folds, or an empty list.
 */
export function useUserTextFolds(): readonly UserTextFold[] {
  return useContext(UserTextFoldsContext)
}
