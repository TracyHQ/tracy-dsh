// @vitest-environment jsdom
/**
 * Tracy: the Workspace row "..." menu and the section label as slots, on
 * SlotTestRuntime (real apply, real WorkspaceBrowser in the sidebar hole).
 * `sidebar.workspaces.workspace.menu.item` carries the shipped Rename and
 * Delete rows as ordinary entries (ids `rename` 100, `delete` 200); a plugin
 * adds a row by `order` and replaces a shipped one per row by shadowing its id
 * at a priority below 0 and rendering `shipped[id]` or nothing.
 * `sidebar.workspaces.section.label` replaces the grouped-view section label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

async function createRuntime(): Promise<SlotTestRuntime> {
  const runtime = await SlotTestRuntime.create()
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
  runtime.ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
  runtime.releaseWorkspaceSource()
  runtime.remote.provideNamespaces({ directoryPicker: {} })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  return runtime
}

type FrameProps = PropsRenderSlots<'sidebar.workspaces' | 'shell.overlay'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return (
    <>
      {renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}
      {renderSlot('shell.overlay', {})}
    </>
  )
}

async function assemble(): Promise<SlotTestRuntime> {
  const runtime = await createRuntime()
  await runtime.workspaces.update((draft) => {
    draft.items = [
      {
        workspaceId: 'w1' as WorkspaceId, title: 'alpha', path: '/site/alpha',
        sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        workspaceId: 'w2' as WorkspaceId, title: 'beta', path: '/site/beta',
        sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ] as never
  })
  await runtime.root.declare(
    {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    } as never,
    SidebarFrame as never,
  )
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

/** Open a Workspace row's menu and read its rows. */
async function openMenu(view: ReturnType<SlotTestRuntime['renderRoot']>, name: string): Promise<string[]> {
  const row = (await within(view.container).findByText(name)).closest('[role="treeitem"]') as HTMLElement
  fireEvent.click(within(row).getByLabelText(`工作区“${name}”的操作`))
  return (await view.findAllByRole('menuitem')).map(item => item.textContent ?? '')
}

type MenuEntryProps = PropsRuntime<'sidebar.workspaces.workspace.menu.item'>

describe('Tracy: workspace row menu slot', () => {
  it('with nothing plugged in, the menu is Rename then Delete workspace, and Delete opens the dialog', async () => {
    const runtime = await assemble()
    const view = runtime.renderRoot()
    expect(await openMenu(view, 'alpha')).toEqual(['重命名', '删除工作区'])
    fireEvent.click(view.getByRole('menuitem', { name: '删除工作区' }))
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
    expect(await view.findByRole('dialog')).toBeTruthy()
    expect(view.getByText(/将把“alpha”从工作区列表中移除/)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  })

  it('a plugin row at order 150 lands between Rename and Delete and gets the row facts', async () => {
    const runtime = await assemble()
    const selected = vi.fn()
    runtime.slots.register(
      { name: 'sidebar.workspaces.workspace.menu.item', id: 'test.leave', order: 150 },
      ({ workspaceId, path, title, MenuItem, useMenuOpenState }: MenuEntryProps) => {
        const [, setOpen] = useMenuOpenState()
        return <MenuItem onSelect={() => { setOpen(false); selected(workspaceId, path, title) }}>Leave</MenuItem>
      },
    )
    const view = runtime.renderRoot()
    expect(await openMenu(view, 'alpha')).toEqual(['重命名', 'Leave', '删除工作区'])
    fireEvent.click(view.getByRole('menuitem', { name: 'Leave' }))
    expect(selected).toHaveBeenCalledWith('w1', '/site/alpha', 'alpha')
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
  })

  it('shadowing a shipped id below priority 0 replaces that row only on the rows the plugin takes over', async () => {
    const runtime = await assemble()
    const takenOver = (path: string) => path === '/site/alpha'
    for (const id of ['rename', 'delete'] as const) {
      runtime.slots.register(
        { name: 'sidebar.workspaces.workspace.menu.item', id, order: id === 'rename' ? 100 : 200, priority: -1 },
        ({ path, shipped }: MenuEntryProps) => takenOver(path) ? null : shipped[id],
      )
    }
    runtime.slots.register(
      { name: 'sidebar.workspaces.workspace.menu.item', id: 'test.delete-site', order: 300 },
      ({ path, MenuItem }: MenuEntryProps) => takenOver(path)
        ? <MenuItem danger onSelect={() => {}}>Delete site</MenuItem>
        : null,
    )
    const view = runtime.renderRoot()
    expect(await openMenu(view, 'alpha')).toEqual(['Delete site'])
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(view.queryByRole('menu')).toBeNull() })
    expect(await openMenu(view, 'beta')).toEqual(['重命名', '删除工作区'])
    // The kept shipped row still opens the browser's own dialog.
    fireEvent.click(view.getByRole('menuitem', { name: '删除工作区' }))
    expect(await view.findByText(/将把“beta”从工作区列表中移除/)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  })
})

describe('Tracy: section label seat', () => {
  it('with nothing plugged in, the grouped view says Workspaces', async () => {
    const runtime = await assemble()
    const view = runtime.renderRoot()
    await within(view.container).findByText('alpha')
    expect(within(view.container).getByText('工作区')).toBeTruthy()
  })

  it('an occupant replaces the label and receives the shipped one', async () => {
    const runtime = await assemble()
    const seen = vi.fn()
    runtime.slots.register(
      { name: 'sidebar.workspaces.section.label' },
      ({ label }: PropsRuntime<'sidebar.workspaces.section.label'>) => { seen(label); return 'Site' },
    )
    const view = runtime.renderRoot()
    await within(view.container).findByText('alpha')
    expect(within(view.container).getByText('Site')).toBeTruthy()
    expect(within(view.container).queryByText('工作区')).toBeNull()
    expect(seen).toHaveBeenCalledWith('工作区')
  })
})
