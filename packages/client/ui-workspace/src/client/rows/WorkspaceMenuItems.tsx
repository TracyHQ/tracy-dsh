/**
 * Tracy: the shipped entries of `sidebar.workspaces.workspace.menu.item`.
 * The Workspace row builds its Rename and Delete rows (their dialogs belong to
 * the browser) and hands them over as the owner's `shipped`; these entries
 * render them by id, so the menu is unchanged with nothing else registered
 * and a plugin that shadows an id can keep the shipped row per row.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type Props = PropsRuntime<'sidebar.workspaces.workspace.menu.item'>

/** Shipped `rename` entry (order 100). */
export function ShippedRenameWorkspaceItem({ shipped }: Props) {
  return shipped.rename
}

/** Shipped `delete` entry (order 200). */
export function ShippedDeleteWorkspaceItem({ shipped }: Props) {
  return shipped.delete
}
