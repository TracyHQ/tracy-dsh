/**
 * Per-browser language persistence for remote pages. A non-loopback page runs
 * its settings forms in memory mode and never writes the host-wide document,
 * so the Language choice lives in this origin's localStorage. Every access is
 * guarded: a private window or blocked storage reads as "nothing stored" and a
 * failed write is dropped, never thrown.
 */
import { LOCALE_ID_PATTERN, LOCALE_LOCAL_STORAGE_KEY, type LocaleId } from './locale-settings.ts'

/** Minimal Storage face, so tests and non-browser runs can pass a stand-in. */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): StorageLike | undefined {
  try {
    // Firefox with storage disabled exposes localStorage as null, which the DOM types omit.
    const store: Storage | null | undefined = typeof localStorage === 'undefined' ? undefined : localStorage
    return store ?? undefined
  } catch (error) {
    // Reading the localStorage property throws a SecurityError where site data is blocked.
    void error
    return undefined
  }
}

/**
 * Read the stored language choice, keeping it only when it is a well-formed id.
 * Whether that language is registered is the runtime's concern: an id with no
 * definition simply never resolves, so a removed language falls back on its own.
 * @returns the stored id, or undefined when nothing usable is stored.
 */
export function readLocalLocalePreference(): LocaleId | undefined {
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(LOCALE_LOCAL_STORAGE_KEY)
  } catch (error) {
    // A blocked store reads as nothing stored.
    void error
    return undefined
  }
  if (raw === null || raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    // A corrupt stored value reads as nothing stored.
    void error
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { preference } = parsed as Record<string, unknown>
  return typeof preference === 'string' && LOCALE_ID_PATTERN.test(preference) ? preference : undefined
}

/**
 * Store the language choice for this browser; failures are dropped.
 * @param preference - a registered locale id the user picked.
 */
export function writeLocalLocalePreference(preference: LocaleId): void {
  try {
    storage()?.setItem(LOCALE_LOCAL_STORAGE_KEY, JSON.stringify({ preference }))
  } catch (error) {
    // Blocked or full storage: the choice still applies for this page.
    void error
  }
}

/**
 * Forget this browser's language choice, so the page follows the browser's
 * language list again; failures are dropped.
 */
export function clearLocalLocalePreference(): void {
  try {
    storage()?.removeItem(LOCALE_LOCAL_STORAGE_KEY)
  } catch (error) {
    // Blocked storage: nothing could have been stored there either.
    void error
  }
}
