/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference and content font size.
 * Head CSS colors the document canvas before script execution; the body script
 * installs the palette selector and font size that the client presenters adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_MAX, FONT_SIZE_MIN, THEME_LOCAL_STORAGE_KEY, THEME_PREFERENCES,
  type ThemePreference,
} from './theme-settings.ts'

const LIGHT_BACKGROUND = '#fff'
const DARK_BACKGROUND = '#151517'

/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference: ThemePreference): string {
  const light = `:root{color-scheme:light}body{background-color:${LIGHT_BACKGROUND};--dsh-boot-bg:${LIGHT_BACKGROUND}}`
  const dark = `:root{color-scheme:dark}body{background-color:${DARK_BACKGROUND};--dsh-boot-bg:${DARK_BACKGROUND}}`
  if (preference === 'light') return light
  if (preference === 'dark') return dark
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/**
 * Build the body script that installs the palette selector and content size.
 * On a non-loopback page (memory-mode settings, see local-preference.ts) a
 * valid choice stored in this browser replaces the Host value and re-colors
 * the canvas with an appended head style, so a reload paints the user's own
 * theme first. Loopback pages never read storage; blocked or missing storage
 * keeps the Host value.
 */
function bootThemeBodyScript(hostPreference: ThemePreference, hostFontSize: number): string {
  const canvas = Object.fromEntries(THEME_PREFERENCES.map(p => [p, bootThemeStyle(p)]))
  return `(() => {
  let preference = ${JSON.stringify(hostPreference)}
  let fontSize = ${JSON.stringify(hostFontSize)}
  const host = typeof location === 'undefined' ? '' : location.hostname
  const parts = host.split('.')
  const loopback = host === 'localhost' || host === '[::1]'
    || (parts.length === 4 && parts[0] === '127' && parts.every(part => /^\\d{1,3}$/.test(part) && Number(part) <= 255))
  let raw = null
  if (!loopback) {
    try {
      raw = localStorage.getItem(${JSON.stringify(THEME_LOCAL_STORAGE_KEY)})
    } catch (error) {
      // Blocked or missing storage keeps the Host value.
      void error
    }
  }
  let stored = null
  try {
    stored = JSON.parse(raw || 'null')
  } catch (error) {
    // A corrupt stored value keeps the Host value.
    void error
  }
  if (stored !== null && typeof stored === 'object') {
    if (${JSON.stringify(THEME_PREFERENCES)}.includes(stored.preference)) preference = stored.preference
    if (Number.isInteger(stored.fontSize) && stored.fontSize >= ${FONT_SIZE_MIN} && stored.fontSize <= ${FONT_SIZE_MAX}) fontSize = stored.fontSize
  }
  if (preference !== ${JSON.stringify(hostPreference)}) {
    const canvas = document.createElement('style')
    canvas.setAttribute('data-dsh-boot-theme', '')
    canvas.textContent = ${JSON.stringify(canvas)}[preference]
    document.head.append(canvas)
  }
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', fontSize + 'px')
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector and font
 * size before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSize - Current Host-backed content font size in px.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_FONT_SIZE,
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSize) },
  ]
}
