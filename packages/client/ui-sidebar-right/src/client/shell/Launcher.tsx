/** Registry-backed add menu for a pane, including its initial empty state. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconPlusOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightLauncher, SidebarRightOpenTabOptions } from '../service.ts'
import type { SidebarRightGuideBox } from '../tab-registry.ts'
import css from './SidebarRight.module.css'

interface LauncherProps {
  readonly launcher: SidebarRightLauncher
  readonly entries: readonly SidebarRightGuideBox[]
  readonly paneId: PaneId
  readonly guideId: TabId | undefined
  readonly active: boolean
  readonly openTab: (kind: string, options?: SidebarRightOpenTabOptions) => void
}

/** @param props - pane, registry entries and product labels. @returns its add control and anchored menu. */
export function Launcher({ launcher, entries, paneId, guideId, active, openTab }: LauncherProps): ReactNode {
  // Closed until the user clicks +. A pane's guide tab survives real tabs opened beside it and is
  // restored from the saved layout, so opening on its presence reopened the menu on every load.
  // The guide only decides what a pick replaces; the empty pane shows the launcher's emptyLabel.
  const [open, setOpen] = useState(false)
  const items = launcher.kinds.flatMap(kind => {
    const entry = entries.find(candidate => candidate.kind === kind)
    if (entry === undefined) return []
    const Icon = entry.icon
    return [{ id: kind, label: entry.title(), ...(Icon === undefined ? {} : { icon: <Icon size={12} /> }) }]
  })
  return <Menu
    open={active && open && items.length > 0}
    portal
    compact
    autoFocus
    collisionAvoidance
    align="start"
    onClose={() => { setOpen(false) }}
    items={items}
    onSelect={kind => {
      setOpen(false)
      openTab(kind, { paneId, ...(guideId === undefined ? {} : { replaceTab: guideId }) })
    }}
    anchor={<button
      type="button"
      className={css.iconButton}
      aria-label={launcher.label}
      aria-haspopup="menu"
      aria-expanded={active && open}
      data-sidebar-right-launcher={paneId}
      onPointerDown={event => { event.stopPropagation() }}
      onClick={event => { event.stopPropagation(); setOpen(value => !value) }}
    ><IconPlusOutlineRegular size={14} /></button>}
  />
}
