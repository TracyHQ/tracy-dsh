/**
 * The Conversation width the user chose, kept in this browser across reloads,
 * Sessions and tabs. One px number under one key: the frame clamps it to the
 * current window on every read, so a width saved on a wide screen is still
 * valid on a narrow one. Storage can be absent or refuse (private windows,
 * blocked site data); every access degrades to "no saved width".
 */

/**
 * localStorage key of the saved Conversation width. Tracy: versioned (v2, 14/10/2026) when the
 * default became a narrow Conversation, so a width saved under the old wide defaults is ignored.
 */
export const CHAT_WIDTH_KEY = 'dsh-layout:chat-width:v2'

/**
 * Parse one stored value.
 * @param raw - the stored string, or null when absent.
 * @returns a positive finite width, or null.
 */
export function parseChatWidth(raw: string | null): number | null {
  if (raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** @returns the saved Conversation width, or null when none is saved or storage is unavailable. */
export function readChatWidth(): number | null {
  try {
    return parseChatWidth(window.localStorage.getItem(CHAT_WIDTH_KEY))
  } catch {
    return null
  }
}

/**
 * Save a Conversation width; null forgets it (back to the default).
 * @param px - the width to keep, or null.
 */
export function writeChatWidth(px: number | null): void {
  try {
    if (px === null) window.localStorage.removeItem(CHAT_WIDTH_KEY)
    else window.localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(px)))
  } catch {
    // Storage refused: the width still applies for this page, it just is not kept.
  }
}
