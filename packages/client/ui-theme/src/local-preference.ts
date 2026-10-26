/**
 * Per-browser theme persistence for remote pages. A non-loopback page runs its
 * settings forms in memory mode and never writes the host-wide document, so
 * the Appearance and font-size choices live in this origin's localStorage.
 * Every access is guarded: a private window or blocked storage reads as
 * "nothing stored" and a failed write is dropped, never thrown.
 */
import {
  FONT_SIZE_MAX, FONT_SIZE_MIN, isThemePreference, THEME_LOCAL_STORAGE_KEY, type ThemeSettings,
} from './theme-settings.ts'

/** Minimal Storage face, so tests and non-browser runs can pass a stand-in. */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

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

function readStoredJson(): unknown {
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(THEME_LOCAL_STORAGE_KEY)
  } catch (error) {
    // A blocked store reads as nothing stored.
    void error
    return undefined
  }
  if (raw === null || raw === undefined) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    // A corrupt stored value reads as nothing stored.
    void error
    return undefined
  }
}

/**
 * Read the stored choice, keeping only the fields that pass the schema bounds.
 * @returns the valid stored fields; empty when nothing usable is stored.
 */
export function readLocalThemeSettings(): Partial<ThemeSettings> {
  const parsed = readStoredJson()
  if (typeof parsed !== 'object' || parsed === null) return {}
  const { preference, fontSize } = parsed as Record<string, unknown>
  const result: Partial<ThemeSettings> = {}
  if (isThemePreference(preference)) result.preference = preference
  if (Number.isInteger(fontSize) && (fontSize as number) >= FONT_SIZE_MIN && (fontSize as number) <= FONT_SIZE_MAX) {
    result.fontSize = fontSize as number
  }
  return result
}

/**
 * Store the whole theme section for this browser; failures are dropped.
 * @param settings - the current built-in preference and font size.
 */
export function writeLocalThemeSettings(settings: ThemeSettings): void {
  const value = JSON.stringify({ preference: settings.preference, fontSize: settings.fontSize })
  try {
    storage()?.setItem(THEME_LOCAL_STORAGE_KEY, value)
  } catch (error) {
    // Blocked or full storage: the choice still applies for this page.
    void error
  }
}
