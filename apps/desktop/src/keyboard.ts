/** Product-window preference IPC and native menu interception during physical-key dispatch/recording. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type Input, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { bindingKey, effectiveShortcuts, presentBinding, parseShortcutDefinitions, parseShortcutEdit } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { NormalizedBinding, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutPlatform, ShortcutRevision } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { desktopKeybindings } from './keybindings.ts'
import { DESKTOP_IPC, SCHEME } from './ipc.ts'

/**
 * The Desktop application document, the only product page this application serves.
 * @param url - top-frame document URL.
 * @returns whether the URL is `dsh-app://app/…`.
 */
export function isApplicationDocument(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${SCHEME}:` && parsed.hostname === 'app'
  } catch {
    return false
  }
}

/**
 * Install application-owned configuration handlers and attach each product window's input lifecycle.
 * @param getWindow - current product window.
 * @param userData - Electron-resolved device preference directory.
 * @param platform - local device platform.
 * @param updateMenu - rebuild the application menu when the close accelerator or availability changes.
 * @param overlayInput - Current shell-owned input blocking state for the product window.
 * @param trusted - whether a top-frame document URL is the product page; an embedder that serves the product from
 *   its own origin passes that origin's test. Defaults to the Desktop application document.
 * @param products - every product window (Tracy fork, TRACY-FORK.md): an embedder with several windows passes its
 *   registry; each window's page registers its own shortcuts and is answered by `event.sender`, the configuration file
 *   stays shared and every window hears a change, and keys/menus go to `getWindow()` (the focused one). Defaults to
 *   the one window `getWindow()` returns, which is the Desktop application's behaviour.
 * @returns menu construction, editor key delivery, window attachment, and teardown operations.
 */
export function installDesktopShortcuts(
  getWindow: () => BrowserWindow | undefined, userData: string, platform: ShortcutPlatform, updateMenu: () => void,
  overlayInput: (window: BrowserWindow) => { readonly revision: number; readonly blocked: boolean },
  trusted: (url: string) => boolean = isApplicationDocument,
  products: () => Iterable<BrowserWindow> = () => { const window = getWindow(); return window === undefined ? [] : [window] },
): {
  fileMenu(labels: { fileMenu: string; closePage: string }): MenuItemConstructorOptions
  /**
   * Send a native Edit action to the editor without matching user shortcuts.
   * @param keyCode - edit key.
   * @param modifiers - edit modifiers.
   */
  sendEditingKey(keyCode: string, modifiers: Array<'control'>): void
  attach(window: BrowserWindow): void
  /**
   * Intercept an approved browser guest's keys until its lease ends.
   * @param window - owning product window.
   * @param guest - approved browser contents.
   * @param name - main-issued lease used as the webview element name.
   * @returns idempotent listener disposer.
   */
  attachGuest(window: BrowserWindow, guest: WebContents, name: DesktopBrowserLeaseId): () => void
  dispose(): void
} {
  /** One product page's registration: its catalog, recording state, and the bindings indexed from it. */
  interface PageShortcuts {
    definitions: readonly ShortcutDefinition[]
    recording: boolean
    keys: Set<string>
    closeBinding: NormalizedBinding | null
  }
  // Tracy fork: per product page (keyed by the window's top contents), so one window's reload or recording
  // leaves the others alone. The accepted configuration and its revision stay one, shared by every page.
  const pages = new Map<WebContents, PageShortcuts>()
  let snapshot: ShortcutConfigSnapshot | undefined
  let editingInput: BrowserWindow['webContents'] | undefined
  const scopedDesktop = platform === 'windows' || platform === 'macos'
  const disposers = new Set<() => void>()
  const guestInputs = new Map<WebContents, { window: BrowserWindow; reset(): void }>()
  const pageOf = (window: BrowserWindow | undefined): PageShortcuts | undefined =>
    window === undefined || window.isDestroyed() ? undefined : pages.get(window.webContents)
  /** The revision a page's input carries: none until it registered and the configuration loaded. */
  const revisionOf = (page: PageShortcuts | undefined): ShortcutRevision | undefined =>
    page === undefined || page.definitions.length === 0 || snapshot === undefined || snapshot.status === 'loading'
      ? undefined : snapshot.revision
  /** The page the application menu speaks for: the current window's, else any registered one. */
  const menuPage = (): PageShortcuts | undefined => pageOf(getWindow()) ?? pages.values().next().value
  const closeAccelerator = (): string | undefined => presentBinding(menuPage()?.closeBinding ?? null, platform).aria
    ?.replace('Meta+', 'Command+').replace(/Arrow(Up|Down|Left|Right)$/u, '$1')
  const menuState = (): string => `${revisionOf(menuPage()) !== undefined} ${closeAccelerator() ?? ''}`
  let shownMenu = menuState()
  const refreshMenu = (): void => {
    const next = menuState()
    if (next === shownMenu) return
    shownMenu = next
    updateMenu()
  }
  const sendMenuClose = (): void => {
    const window = getWindow()
    const page = pageOf(window)
    const revision = revisionOf(page)
    if (window === undefined || window.isDestroyed() || !window.isFocused() || !window.isEnabled()
      || revision === undefined || page?.recording === true || overlayInput(window).blocked) return
    window.webContents.send(DESKTOP_IPC.shortcutsInput, { kind: 'menu', commandId: 'page.close', revision })
  }
  /** Rebuild one page's binding index from the accepted configuration. */
  const index = (page: PageShortcuts): void => {
    const rows = snapshot === undefined || snapshot.status === 'loading' ? []
      : effectiveShortcuts(page.definitions, snapshot.document, 'desktop', platform)
    page.keys = new Set(rows.flatMap(row => row.binding !== null && row.issue === null && row.conflicts.length === 0
      ? [bindingKey(row.binding)] : []))
    const close = rows.find(row => row.id === 'page.close')
    page.closeBinding = close?.issue === null && close.conflicts.length === 0 ? close.binding : null
  }
  const publish = (next: ShortcutConfigSnapshot): void => {
    snapshot = next
    for (const page of pages.values()) index(page)
    refreshMenu()
    for (const window of products()) {
      if (!window.isDestroyed() && trusted(window.webContents.mainFrame.url)) {
        window.webContents.send(DESKTOP_IPC.shortcutsChanged, next)
      }
    }
  }
  const persistence = desktopKeybindings(userData, platform, publish)
  /** The catalog the shared configuration validates edits against: every registered page's commands. */
  const catalog = (): readonly ShortcutDefinition[] | null => {
    const byId = new Map<string, ShortcutDefinition>()
    for (const page of pages.values()) for (const row of page.definitions) if (!byId.has(row.id)) byId.set(row.id, row)
    return pages.size === 0 ? null : [...byId.values()]
  }
  const assertSender = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = [...products()].find(candidate => !candidate.isDestroyed() && event.sender === candidate.webContents)
    if (window === undefined || event.senderFrame !== window.webContents.mainFrame) throw new Error('desktop shortcuts: rejected sender')
    if (!trusted(window.webContents.mainFrame.url)) throw new Error('dsh desktop: rejected IPC from an unowned renderer')
    return window
  }
  ipcMain.handle(DESKTOP_IPC.shortcutsGet, async (event, input: unknown) => {
    const window = assertSender(event)
    const definitions = parseShortcutDefinitions(input)
    const page = pages.get(window.webContents) ?? { definitions, recording: false, keys: new Set<string>(), closeBinding: null }
    page.definitions = definitions
    pages.set(window.webContents, page)
    persistence.setDefinitions(catalog())
    return persistence.readCurrent()
  })
  ipcMain.handle(DESKTOP_IPC.shortcutsEdit, async (event, input: unknown, expectedRevision: unknown) => {
    assertSender(event)
    if (typeof expectedRevision !== 'string') throw new Error('desktop shortcuts: invalid revision')
    return persistence.edit(parseShortcutEdit(input), expectedRevision as ShortcutRevision)
  })
  ipcMain.handle(DESKTOP_IPC.shortcutsRecording, (event, active: unknown) => {
    const window = assertSender(event)
    if (typeof active !== 'boolean') throw new Error('desktop shortcuts: invalid recording state')
    const page = pages.get(window.webContents)
    if (page !== undefined) page.recording = active
    window.webContents.setIgnoreMenuShortcuts(active)
  })
  ipcMain.handle(DESKTOP_IPC.shortcutsCloseWindow, (event, expected: unknown) => {
    const window = assertSender(event)
    const page = pages.get(window.webContents)
    const revision = revisionOf(page)
    if (expected !== revision || revision === undefined || page?.recording === true || !window.isFocused() || !window.isEnabled()
      || overlayInput(window).blocked) return
    window.close()
  })
  function attachInput(window: BrowserWindow, contents: WebContents, guestName?: DesktopBrowserLeaseId): () => void {
    let deadKey = false
    const held = new Set<string>()
    const consumed = new Map<string, 'press' | 'repeat'>()
    let inputFrame: typeof contents.focusedFrame = null
    let inputRevision: ShortcutRevision | undefined
    let overlayRevision = overlayInput(window).revision
    const resetInput = (): void => {
      deadKey = false; held.clear(); consumed.clear(); inputFrame = null; inputRevision = undefined
      if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false)
    }
    if (guestName !== undefined) guestInputs.set(contents, { window, reset: resetInput })
    const resetWindow = (): void => {
      resetInput()
      for (const guest of guestInputs.values()) if (guest.window === window) guest.reset()
    }
    const clear = (): void => {
      resetInput()
      if (guestName !== undefined) return
      // Only this window's page: another window's registration and keys stay as they are. Keyed by the
      // contents captured at attach: after BrowserWindow.destroy() the window's own getter throws.
      if (!pages.delete(contents)) return
      persistence.setDefinitions(catalog())
    }
    const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (event.isMainFrame && !event.isSameDocument) clear()
    }
    const beforeInput = (event: Electron.Event, input: Input): void => {
      const overlay = overlayInput(window)
      if (overlay.revision !== overlayRevision) { resetInput(); overlayRevision = overlay.revision }
      if (overlay.blocked) { event.preventDefault(); return }
      if (event.defaultPrevented) { resetInput(); return }
      if (editingInput === contents) {
        held.clear()
        consumed.clear()
        contents.setIgnoreMenuShortcuts(true)
        return
      }
      const page = pageOf(window)
      const revision = revisionOf(page)
      if (page === undefined || window !== getWindow() || !window.isFocused() || !window.isEnabled() || revision === undefined
        || (guestName !== undefined && !contents.isFocused())) {
        contents.setIgnoreMenuShortcuts(false)
        held.clear()
        consumed.clear()
        return
      }
      const modifiers = (['control', 'alt', 'shift', 'meta'] as const).filter(modifier => input[modifier])
      const key = bindingKey({ code: input.code, modifiers })
      const { keys, closeBinding, recording } = page
      const match = keys.has(key)
      const menuMatch = closeBinding !== null && closeBinding.secondCode === undefined && modifiers.join('+') === closeBinding.modifiers.join('+')
        && input.key.toUpperCase() === (closeBinding.code.startsWith('Key') ? closeBinding.code.slice(3) : input.code === closeBinding.code ? input.key.toUpperCase() : '')
      contents.setIgnoreMenuShortcuts(recording || match || menuMatch)
      const frame = contents.focusedFrame
      const composing = input.isComposing || input.key === 'Dead' || deadKey || input.modifiers.includes('altgr')
      if (input.type === 'keyDown') deadKey = input.key === 'Dead'
      if (recording || composing || frame === null) { held.clear(); consumed.clear(); return }
      let binding: NormalizedBinding = { code: input.code, modifiers }
      let priority = false
      if (scopedDesktop) {
        if (frame !== inputFrame || inputRevision !== revision) { held.clear(); inputFrame = frame; inputRevision = revision }
        const modifierKey = /^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(input.code)
        if (input.type === 'keyUp') {
          // A chord's first key reached the renderer, so its release must reach the same input handlers.
          if (consumed.get(input.code) === 'press') event.preventDefault()
          consumed.delete(input.code)
          held.delete(input.code)
          if (modifierKey) held.clear()
          return
        }
        if (!input.isAutoRepeat) consumed.delete(input.code)
        if (modifierKey) { held.clear(); return }
        if (input.isAutoRepeat && consumed.has(input.code) && !match) { event.preventDefault(); return }
        if (input.isAutoRepeat && !held.has(input.code) && !match) return
        held.add(input.code)
        const codes: [string, ...string[]] = [input.code, ...[...held].filter(value => value !== input.code)]
        codes.sort()
        const pair = { code: codes[0], ...(codes[1] === undefined ? {} : { secondCode: codes[1] }), modifiers }
        priority = keys.has(key)
        if (codes.length === 2 && keys.has(bindingKey(pair))) { binding = pair; priority = true }
      }
      const main = guestName === undefined && frame === contents.mainFrame
      if (!priority && (main || !match)) return
      event.preventDefault()
      if (input.type !== 'keyDown') return
      if (scopedDesktop) {
        if (!input.isAutoRepeat) {
          if (binding.secondCode !== undefined) {
            consumed.set(binding.code, 'repeat')
            consumed.set(binding.secondCode, 'repeat')
          }
          consumed.set(input.code, 'press')
        }
        // Electron can omit both keyups after interception; completed presses cannot seed another chord.
        held.clear()
      }
      let embedding = frame
      while (guestName === undefined && !main && embedding.parent !== null && embedding.parent !== contents.mainFrame) {
        embedding = embedding.parent
      }
      window.webContents.send(DESKTOP_IPC.shortcutsInput, { kind: guestName === undefined ? main ? 'keyboard' : 'iframe' : 'webview',
        revision, frameName: guestName ?? (main ? '' : embedding.name),
        code: binding.code, ...(binding.secondCode === undefined ? {} : { secondCode: binding.secondCode }),
        repeat: input.isAutoRepeat, control: input.control, alt: input.alt, shift: input.shift, meta: input.meta })
    }
    const dispose = (): void => {
      contents.off('did-start-navigation', navigation)
      contents.off('before-input-event', beforeInput)
      contents.off('blur', resetInput)
      contents.off('destroyed', dispose)
      if (guestName === undefined) { window.off('blur', resetWindow); window.off('closed', closed) }
      disposers.delete(dispose)
      guestInputs.delete(contents)
      if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false)
    }
    const closed = (): void => { clear(); dispose() }
    contents.on('did-start-navigation', navigation)
    contents.on('before-input-event', beforeInput)
    contents.on('blur', resetInput)
    contents.once('destroyed', dispose)
    if (guestName === undefined) { window.on('closed', closed); window.on('blur', resetWindow) }
    disposers.add(dispose)
    return dispose
  }

  return {
    sendEditingKey(keyCode, modifiers) {
      const window = getWindow()
      if (window === undefined || window.isDestroyed() || overlayInput(window).blocked) return
      const contents = [...guestInputs].find(([guest, owner]) => owner.window === window && !guest.isDestroyed() && guest.isFocused())?.[0]
        ?? window.webContents
      contents.focus()
      const previous = editingInput
      editingInput = contents
      try {
        // Electron emits before-input-event synchronously for these editor-owned keys.
        contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
        contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      } finally {
        editingInput = previous
        if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(pageOf(window)?.recording ?? false)
      }
    },
    fileMenu: (labels) => {
      const accelerator = closeAccelerator()
      return { label: labels.fileMenu, submenu: [{
        id: 'dsh-page-close', label: labels.closePage, enabled: revisionOf(menuPage()) !== undefined,
        ...accelerator === undefined ? {} : { accelerator },
        click: sendMenuClose,
      }] }
    },
    attach(window) { attachInput(window, window.webContents) },
    attachGuest: attachInput,
    dispose() {
      for (const dispose of disposers) dispose()
      persistence.dispose()
      for (const channel of [DESKTOP_IPC.shortcutsGet,
        DESKTOP_IPC.shortcutsEdit, DESKTOP_IPC.shortcutsRecording, DESKTOP_IPC.shortcutsCloseWindow]) {
        ipcMain.removeHandler(channel)
      }
    },
  }
}
