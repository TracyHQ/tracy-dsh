/**
 * The current session on the address bar: `<base>s/<sessionId>`.
 *
 * The page address is the one thing a person can copy, bookmark, reload and hand to a teammate,
 * and the only navigation state the browser's Back and Forward buttons act on. This module keeps
 * it equal to the Workspace navigation's main selection: a selection change writes the address, an address
 * change (Back, Forward, a pasted link at boot) selects the session it names. The served index
 * carries a `<base href>` naming the mount a reverse proxy published dsh under, so every address
 * is built relative to it and stays right at the root and under a prefix alike.
 *
 * Outside a browser (tests, a non-page caller) nothing here does anything.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A session id as it may appear in a path segment: no slashes, no dots, so a missing asset under `s/` is never mistaken for a session. */
const SESSION_SEGMENT = /^[A-Za-z0-9_-]+$/

/** The page's `<base href>` pathname, else `/` — always ending in `/`. */
function basePath(): string {
  const base = document.querySelector('base[href]')?.getAttribute('href')
  if (base === null || base === undefined) return '/'
  const path = new URL(base, location.href).pathname
  return path.endsWith('/') ? path : `${path}/`
}

/** Whether this code runs on a page whose address it may read and write. */
function onPage(): boolean {
  return typeof document !== 'undefined' && typeof history !== 'undefined' && typeof location !== 'undefined'
}

/**
 * The session the address names, or undefined at the base itself (or anywhere the address is not
 * `<base>s/<id>`).
 * @returns the id named by the current address.
 */
export function sessionInAddress(): SessionId | undefined {
  if (!onPage()) return undefined
  const base = basePath()
  const path = location.pathname
  if (!path.startsWith(`${base}s/`)) return undefined
  const rest = path.slice(base.length + 2).replace(/\/$/, '')
  return SESSION_SEGMENT.test(rest) ? (rest as SessionId) : undefined
}

/**
 * Whether the first mirror after boot should leave the address alone for now.
 *
 * Tracy, 20/09/2026. Before the selection settles (`mainReference` undefined, nothing synced yet)
 * the mirror used to correct the address to the bare base, and a beat later write `s/<id>` —
 * measured on the dev host as `s/<id> → base → s/<id>` whenever a plugin had already put the
 * session on the bar. An address naming a session the list HAS is not wrong, only early: hold it
 * and let the settled selection confirm or replace it. One naming a session the list does not
 * have is wrong, and is still corrected at once.
 * @param input.current - the validated selection, undefined while none.
 * @param input.synced - whether a session has been on the bar once already.
 * @param input.addressed - the session the address names, undefined at the base.
 * @param input.listed - whether the session list has that id.
 * @returns true to skip this write.
 */
export function holdsAddress(input: {
  current: SessionId | undefined
  synced: boolean
  addressed: SessionId | undefined
  listed: (id: SessionId) => boolean
}): boolean {
  if (input.synced || input.current !== undefined) return false
  return input.addressed !== undefined && input.listed(input.addressed)
}

/**
 * Write a session (or none) to the address bar without reloading.
 * @param id - the session to name, or undefined for the base address.
 * @param mode - `push` records a history entry (a person changed session); `replace` does not
 * (boot restore, or correcting an address the list no longer has).
 */
export function writeAddress(id: SessionId | undefined, mode: 'push' | 'replace'): void {
  if (!onPage()) return
  const next = `${basePath()}${id === undefined ? '' : `s/${id}`}${location.search}${location.hash}`
  const current = `${location.pathname}${location.search}${location.hash}`
  if (next === current) return
  if (mode === 'push') history.pushState(null, '', next)
  else history.replaceState(null, '', next)
}

/**
 * Follow Back and Forward: when the address changes underneath the page, hand the named session
 * (or none) to the caller.
 * @param onAddress - receives the session the new address names.
 * @returns the disposer removing the listener.
 */
export function followAddress(onAddress: (id: SessionId | undefined) => void): () => void {
  if (!onPage()) return () => {}
  const listener = (): void => { onAddress(sessionInAddress()) }
  window.addEventListener('popstate', listener)
  return () => { window.removeEventListener('popstate', listener) }
}
