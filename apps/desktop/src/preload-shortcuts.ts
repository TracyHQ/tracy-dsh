/** Shortcut bridge of the product page: native key delivery and device-local shortcut preferences. */

import type { DesktopKeyboardApi, DesktopShortcutInput, DesktopShortcutsApi, ShortcutConfigSnapshot, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/**
 * Native key delivery from the main process's `installDesktopShortcuts`.
 * @returns the `dshDesktop.keyboard` member of a product page.
 */
export function createKeyboardApi(): DesktopKeyboardApi {
  return {
    closeWindow: revision => ipcRenderer.invoke(DESKTOP_IPC.shortcutsCloseWindow, revision) as Promise<void>,
    subscribe: (listener) => {
      const handle = (_event: Electron.IpcRendererEvent, input: DesktopShortcutInput): void => {
        if (input.kind === 'iframe') {
          const element = document.activeElement
          if (!(element instanceof HTMLIFrameElement) || !element.isConnected
            || !element.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')) return
          if (input.frameName === '' || element.name !== input.frameName) return
        }
        if (input.kind === 'webview') {
          const element = document.activeElement
          if (element?.matches('webview[data-sidebar-browser-frame]') !== true || !element.isConnected
            || input.frameName === '' || element.getAttribute('name') !== input.frameName) return
        }
        listener(input)
      }
      ipcRenderer.on(DESKTOP_IPC.shortcutsInput, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsInput, handle) }
    },
  }
}

/**
 * Device-local shortcut preferences the main process persists.
 * @returns the `dshDesktop.shortcuts` member of a product page.
 */
export function createShortcutsApi(): DesktopShortcutsApi {
  return {
    get: definitions => ipcRenderer.invoke(DESKTOP_IPC.shortcutsGet, definitions) as Promise<ShortcutConfigSnapshot>,
    edit: (edit, revision) => ipcRenderer.invoke(DESKTOP_IPC.shortcutsEdit, edit, revision) as Promise<ShortcutSaveResult>,
    recording: active => ipcRenderer.invoke(DESKTOP_IPC.shortcutsRecording, active) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, snapshot: ShortcutConfigSnapshot): void => { listener(snapshot) }
      ipcRenderer.on(DESKTOP_IPC.shortcutsChanged, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsChanged, handle) }
    },
  }
}
