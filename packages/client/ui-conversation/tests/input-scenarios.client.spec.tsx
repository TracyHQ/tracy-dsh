// @vitest-environment jsdom
/**
 * Scenario-chain integration (scenarios A/C/D/H/I): the real per-session
 * InputTriggerController pipeline over a real session scope (Client Sessions over
 * a listed host session) + a command source implementing the decision
 * table's relevant cells + the real SessionInput machine (scoped-event
 * listeners wired the way the hub does) + the real InputBar. ui-commands
 * itself is not a dependency of this package; the source below is the
 * decision-table contract at the `InputTriggerSource` boundary.
 */
import './control-row-dom.ts'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  ClientSessionContext, SubmitEnvelope,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  CommandClaim, PickOutcome, SubmitAttachment, SubmitOutcome,
} from '../src/client/contract/input.ts'
import {
  bindSnapshotSelector, conversationSnapshot, makeTranslate, sessionSnapshot, SlotTestRuntime,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { $replaceDetectSpanWithText } from '../src/client/input/editor/span-map.ts'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import { zh } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

// jsdom implements no Range geometry (Lexical's scroll-into-view measures the
// caret with one once the surface is genuinely contenteditable).
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})


afterEach(cleanup)

/** Directory row driving kind derivation (input? = leadingInput, else execute). */
interface FakeCommand {
  name: string
  description: string
  input?: { hint: string; attachments?: boolean }
}

/** Decision-table source over an in-memory directory (menu/space/enter columns for leadingInput + execute). */
function commandSource(
  commands: FakeCommand[],
  execute: (line: string, images?: readonly SubmitAttachment[]) => Promise<SubmitOutcome>,
) {
  const resolve = (name: string): FakeCommand | undefined => commands.find(c => c.name === name)
  const leadingClaim = (desc: FakeCommand): CommandClaim => ({
    name: desc.name,
    token: `/${desc.name} `,
    ...(desc.input !== undefined ? { hint: desc.input.hint } : {}),
    ...(desc.input?.attachments === true ? { attachments: true } : {}),
    submit: (args, _actx, images) => execute(`/${desc.name} ${args}`, images),
  })
  const executed: string[] = []
  const envelopes: SubmitEnvelope[] = []
  return {
    executed,
    envelopes,
    source: {
      trigger: '/' as const,
      name: 'command',
      candidates: (_session: ClientSessionContext, req: { query: string; position: string }) =>
        Promise.resolve(commands
          .filter(c => c.name.startsWith(req.query))
          .filter(c => req.position === 'leading' || c.input === undefined)
          .map(c => ({ name: c.name, description: c.description, ...(c.input !== undefined ? { hint: c.input.hint } : {}) }))),
      onPick: (pick: { candidate: { name: string } }): PickOutcome => {
        const desc = resolve(pick.candidate.name)
        if (desc === undefined) return undefined
        if (desc.input !== undefined) return { claim: leadingClaim(desc) }
        executed.push(`/${desc.name}`)
        void execute(`/${desc.name}`)
        return 'handled'
      },
      matchSpace: (_session: ClientSessionContext, token: string): PickOutcome => {
        const desc = resolve(token.slice(1))
        if (desc?.input === undefined) return undefined
        return { claim: leadingClaim(desc) }
      },
      matchEnter: (_session: ClientSessionContext, line: string, _signal: AbortSignal, envelope: SubmitEnvelope): Promise<PickOutcome> => {
        envelopes.push(envelope)
        const trimmed = line.trim()
        const ws = trimmed.search(/\s/)
        const token = ws === -1 ? trimmed : trimmed.slice(0, ws)
        const desc = resolve(token.slice(1))
        if (desc === undefined) return Promise.resolve(undefined)
        if (desc.input !== undefined) return Promise.resolve({ claim: leadingClaim(desc) })
        if (ws !== -1) return Promise.resolve(undefined) // execute with trailing → default sink
        executed.push(trimmed)
        void execute(trimmed)
        return Promise.resolve('handled')
      },
    },
  }
}

const COMMANDS: FakeCommand[] = [
  { name: 'goal', description: '设定目标', input: { hint: '目标内容' } },
  { name: 'compact', description: '压缩上下文' },
  { name: 'vision', description: '识别图片', input: { hint: '想问什么', attachments: true } },
]

const PNG: SubmitAttachment = { type: 'image', mediaType: 'image/png', data: 'AA==' }

/** Real scope bench: a Controller-owned Session scope + InputTriggerController + shell listeners. */
async function scopedBench(register?: (inputTriggers: InputTriggerService) => void) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const ctx = runtime.ctx
  const sessionId = 'scenario-s1' as SessionId
  await runtime.sessions.add({ id: sessionId, summary: { cwd: '/w/a' } })
  const reference = runtime.sessions.retain(sessionId)
  await reference.ready
  onTestFinished(() => { reference.release() })
  await ctx.plugin(InputTriggerService).await()
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
  register?.(inputTriggers)
  const actx = runtime.sessions.scope(sessionId)!
  const controller = inputTriggers.sessionOf(actx)
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const serialize = vi.fn((ids: readonly DraftAttachmentId[]) => Promise.resolve(ids.map(() => PNG)))
  const release = vi.fn()
  const shell = new SessionInputShell({ actx, inputTriggers: () => controller, defaultSink: sink, commandAttachments: { serialize, release, unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported` } })
  // The hub's listener wiring, verbatim.
  actx.on('slash/input-begin-command', req => shell.beginCommand(req.claim, req.span) ? true : undefined)
  actx.on('slash/input-insert-reference', req => shell.insertReference(req.reference, req.span) ? true : undefined)
  actx.on('slash/input-consume-token', req => shell.consumeToken(req.guard) ? true : undefined)
  const wiring = shell
  const sessionStore = createSnapshotStore<SessionSnapshot>(sessionSnapshot(sessionId))
  const barProps: InputBarProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    sessionId,
    SessionProvider: ({ children }) => children,
    useSession: bindSnapshotSelector(sessionStore),
    useSessions: bindSnapshotSelector(createSnapshotStore({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      projectionsBySession: {}, currentAddress: undefined,
    })),
    useSessionStatus: bindSnapshotSelector(
      createSnapshotStore<SessionStatusSnapshot>(new Map()),
    ),
    useSessionRetainInfo: () => undefined,
    useResource,
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })),
    useProjection: (() => undefined),
    useConversation: bindSnapshotSelector(createSnapshotStore(conversationSnapshot())),
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    addFiles: () => null,
    useFileUploads: bindSnapshotSelector(createSnapshotStore({})),
    retryFileUpload: undefined,
    removeAttachment: () => {},
    // Every id resolves so the bar's registry prune never drops a test image.
    resolveDraftAttachments: ids => ids.map(id => ({
      kind: 'image' as const, id,
      file: new File([Uint8Array.of(1)], `${id}.png`, { type: 'image/png' }),
      previewUrl: `blob:${id}`,
    })),
    useBusyEnter: bindSnapshotSelector(createSnapshotStore<'queue' | 'steer'>('queue')),
    toggleCommandMenu: (selection) => {
      const snapshot = shell.snapshot
      controller.toggleSource('command', {
        trigger: '/',
        query: '',
        quoted: false,
        position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
        span: { ...selection, draftRev: snapshot.draftRev },
      })
    },
    useNotices: bindSnapshotSelector(shell.notices),
    useLexicon: bindSnapshotSelector(shell.lexicon),
    useMenuLauncher: bindSnapshotSelector(controller.launcher),
    renderSlot: (() => null) as InputBarProps['renderSlot'],
    stop: vi.fn(),
    useStopShortcut: bindSnapshotSelector(createSnapshotStore<readonly string[]>([])),
    t: makeTranslate(zh, commonZh),
    variant: 'composer',
  }
  const view = render(<InputBar {...barProps} />)
  const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
  const type = (text: string): void => {
    act(() => { shell.setDraft(text) })
  }
  return { runtime, inputTriggers, controller, shell, wiring, view, textarea, type, sink, serialize, release }
}

async function bench(executeImpl?: (line: string) => Promise<SubmitOutcome>) {
  const execute = vi.fn(executeImpl ?? ((line: string) =>
    Promise.resolve({ kind: 'success' as const, text: `已执行 ${line}` })))
  const { source, executed, envelopes } = commandSource(COMMANDS, execute)
  const base = await scopedBench((inputTriggers) => { inputTriggers.registerSource(source) })
  return { ...base, execute, executed, envelopes }
}

describe('scenario A: menu-pick /goal, type args, enter submits', () => {
  it('runs the whole claim chain through the real pipeline', async () => {
    const b = await bench()
    b.type('/go')
    // Candidates land async; the menu opens with the goal row.
    await vi.waitFor(() => {
      const menu = b.controller.menu.getSnapshot()
      expect(menu.open).toBe(true)
      expect(menu.groups[0]?.items.map((i: { name: string }) => i.name)).toContain('goal')
    })
    // Pointer pick (menu path executes through the bound target inside the pipeline).
    act(() => { b.controller.pick('command', 0) })
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.shell.snapshot.draft).toBe('/goal ')
    act(() => { b.shell.editor.update(() => {}, { discrete: true }) }) // flush the queued decoration refresh
    expect(b.view.container.querySelector('[data-lexical-text][style*="business-primary"]')?.textContent).toBe('/goal ')
    // The zh dictionary owns a hint.goal entry, which overrides the machine's raw hint (production behavior).
    expect(b.textarea.style.getPropertyValue('--dsh-composer-hint')).toBe(JSON.stringify('输入目标，智能体将持续执行'))
    // Continue typing args; hint drops; claim holds.
    b.type('/goal 发布 v1')
    expect(b.shell.snapshot.phase).toBe('claimed')
    // Enter: submitting → command execute → commit clears.
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 发布 v1', []) })
    await vi.waitFor(() => { expect(b.shell.snapshot.draft).toBe('') })
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.view.getByText('已执行 /goal 发布 v1')).toBeTruthy()
    expect(b.sink).not.toHaveBeenCalled()
  })
})

describe('scenario C: pasted /goal xxx + enter (menu never opened)', () => {
  it('adjudicates on enter, claims and submits in one stroke', async () => {
    const b = await bench()
    // Paste lands whole; caret at end means detectTrigger sees no token under
    // the caret mid-whitespace — menu stays closed; enter runs adjudication.
    act(() => { b.shell.setDraft('/goal 尽快发布') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 尽快发布', []) })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.shell.snapshot.draft).toBe('')
    expect(b.sink).not.toHaveBeenCalled()
  })
})

describe('scenario D: execute-kind /compact', () => {
  it('menu pick executes immediately without touching the draft machine phase', async () => {
    const b = await bench()
    b.type('/comp')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    act(() => { b.controller.pick('command', 0) })
    // 'handled': no claim, machine still plain; the source ran the detached execute.
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.executed).toContain('/compact')
  })

  it('bare /compact + enter executes; trailing text falls to the default sink (scenario I twin)', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/compact') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.executed).toContain('/compact') })
    // 'handled' flows back as the adjudicated event one microtask later.
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    cleanup()
    const b2 = await bench()
    act(() => { b2.shell.setDraft('/compact 现在') })
    fireEvent.keyDown(b2.textarea, { key: 'Enter' })
    // execute with trailing → matchEnter answers undefined → default sink.
    await vi.waitFor(() => { expect(b2.sink).toHaveBeenCalledWith('/compact 现在', [], 'queue', expect.any(AbortSignal)) })
    expect(b2.executed).toHaveLength(0)
  })
})

/**
 * What a browser does with a focused contenteditable that turns read-only: it drops the focus to the
 * document. jsdom does not, so the bench does it, the one browser behavior these cases rely on.
 */
function dropFocusWhenReadOnly(box: HTMLElement): void {
  const watch = new MutationObserver(() => {
    if (box.getAttribute('contenteditable') === 'false' && document.activeElement === box) box.blur()
  })
  watch.observe(box, { attributes: true, attributeFilter: ['contenteditable'] })
  onTestFinished(() => { watch.disconnect() })
}

describe('scenario: an argued line a command handles returns the keyboard to the composer', () => {
  /** A source that handles every argued line itself, after one macrotask like a real catalog lookup. */
  const handlesArguedLines = (handled: string[]) => (inputTriggers: InputTriggerService): void => {
    inputTriggers.registerSource({
      trigger: '/' as const,
      name: 'command',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
      matchSpace: () => undefined,
      matchEnter: (_session: ClientSessionContext, line: string): Promise<PickOutcome> =>
        new Promise((done) => { setTimeout(() => { handled.push(line.trim()); done('handled') }, 0) }),
    })
  }

  it('focus is back in the composer when the line is handled, with no click', async () => {
    const handled: string[] = []
    const b = await scopedBench(handlesArguedLines(handled))
    dropFocusWhenReadOnly(b.textarea)
    b.textarea.focus()
    expect(document.activeElement).toBe(b.textarea)
    act(() => { b.shell.setDraft('/note remember this') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(handled).toEqual(['/note remember this']) })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.textarea.getAttribute('contenteditable')).toBe('true')
    expect(document.activeElement).toBe(b.textarea)
    expect(b.sink).not.toHaveBeenCalled()
  })

  it('does not take the keyboard back from a control the person moved to meanwhile', async () => {
    const handled: string[] = []
    const b = await scopedBench(handlesArguedLines(handled))
    dropFocusWhenReadOnly(b.textarea)
    const other = document.createElement('button')
    document.body.append(other)
    onTestFinished(() => { other.remove() })
    b.textarea.focus()
    act(() => { b.shell.setDraft('/note remember this') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.textarea.getAttribute('contenteditable')).toBe('false') })
    other.focus()
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(document.activeElement).toBe(other)
  })

  it('a composer that never had the keyboard does not grab it when the line is handled', async () => {
    const handled: string[] = []
    const b = await scopedBench(handlesArguedLines(handled))
    dropFocusWhenReadOnly(b.textarea)
    b.textarea.blur()
    act(() => { b.shell.setDraft('/note remember this') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(handled).toHaveLength(1) })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(document.activeElement).not.toBe(b.textarea)
  })
})

describe('scenario: images ride an accepting command through the real pipeline', () => {
  it('adjudication reports the image count; the claim chain serializes, submits, and consumes', async () => {
    const b = await bench()
    act(() => { b.shell.addAttachments(['img-1' as DraftAttachmentId]) })
    act(() => { b.shell.setDraft('/vision 这张图是什么') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/vision 这张图是什么', [PNG]) })
    // The envelope the controller forwarded to matchEnter carried the count.
    expect(b.envelopes).toEqual([{ attachments: 1 }])
    expect(b.serialize).toHaveBeenCalledWith(['img-1'])
    await vi.waitFor(() => { expect(b.shell.snapshot.draft).toBe('') })
    expect(b.release).toHaveBeenCalledWith(['img-1'])
    expect(b.shell.snapshot.attachmentIds).toEqual([])
    expect(b.sink).not.toHaveBeenCalled()
  })

  it('an imageless enter adjudicates with a zero-image envelope', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/goal 发布') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 发布', []) })
    expect(b.envelopes).toEqual([{ attachments: 0 }])
    expect(b.serialize).not.toHaveBeenCalled()
    expect(b.release).not.toHaveBeenCalled()
  })
})

describe('scenario H: backspace breaks the token', () => {
  it.each(['goal', '目标', 'plan', '计划', 'feedback', '反馈'])('keeps /%s claimed when its arguments and separator are deleted', async (name) => {
    const { source } = commandSource([{ name, description: name, input: { hint: '目标内容' } }],
      () => Promise.resolve({ kind: 'success' }))
    const b = await scopedBench((triggers) => { triggers.registerSource(source) })
    b.type(`/${name}`)
    fireEvent.keyDown(b.textarea, { key: ' ', keyCode: 32 })
    expect(b.shell.snapshot.phase).toBe('claimed')
    b.type(`/${name} 这是目标`)
    for (let i = 0; i < 5; i++) {
      act(() => {
        b.shell.editor.update(() => {
          const end = b.shell.snapshot.draft.length
          $replaceDetectSpanWithText({ start: end - 1, end }, '')
        }, { discrete: true })
      })
    }
    expect(b.shell.snapshot.draft).toBe(`/${name}`)
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.view.container.querySelector('[data-lexical-text][style*="business-primary"]')?.textContent).toBe(`/${name}`)
    b.type(`/${name} `)
    await act(async () => {})
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.shell.snapshot.draft).toBe(`/${name} `)
    expect(b.view.container.querySelector('[data-lexical-text][style*="business-primary"]')?.textContent).toBe(`/${name} `)
    b.type(`/${name}x`)
    expect(b.shell.snapshot.phase).toBe('plain')
  })

  it('claim releases automatically; the enter after that goes through adjudication again', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    // Space adjudication claims (space column, leadingInput).
    fireEvent.keyDown(b.textarea, { key: ' ', keyCode: 32 })
    expect(b.shell.snapshot.phase).toBe('claimed')
    // Backspace into the token: watch break → plain, visuals gone.
    b.type('/goa ')
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.view.container.querySelector('[data-lexical-text][style*="business-primary"]')).toBeNull()
  })
})

describe('scenario: reference decoration lights up when the lexicon settles', () => {
  it('a typed /name token gains the text-ref mark without further input once the roll goes hot', async () => {
    let roll: readonly string[] | undefined
    let notify: (() => void) | undefined
    const b = await scopedBench((inputTriggers) => {
      inputTriggers.registerSource({
        trigger: '/', name: 'skill',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        lexicon: () => roll,
        subscribeLexicon: (_session: ClientSessionContext, listener: () => void) => {
          notify = listener
          return () => { notify = undefined }
        },
      } as never)
    })
    // Typed before the catalog settled: a plain token, no decoration.
    b.type('/deploy now')
    expect(b.view.container.querySelector('[data-composer-text-ref]')).toBeNull()
    // The catalog settles (ui-skill's settle path fires the same notification).
    act(() => {
      roll = ['deploy']
      notify?.()
    })
    act(() => { b.shell.editor.update(() => {}, { discrete: true }) }) // flush the queued re-scan
    const mark = b.view.container.querySelector('[data-composer-text-ref]')
    expect(mark?.textContent).toBe('/deploy')
  })
})

describe('scenario I: unknown /xyz + enter', () => {
  it('adjudication misses in one hop and the whole line rides the default sink', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/xyz 干点啥') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.sink).toHaveBeenCalledWith('/xyz 干点啥', [], 'queue', expect.any(AbortSignal)) })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('adjudication failure (source warmup throw) notices and keeps the draft', async () => {
    const b = await scopedBench((inputTriggers) => {
      inputTriggers.registerSource({
        trigger: '/', name: 'command',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        matchEnter: () => Promise.reject(new Error('目录预热失败')),
      } as never)
    })
    act(() => { b.shell.setDraft('/plan 上线') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.view.getByText('目录预热失败')).toBeTruthy() })
    // Never a silent downgrade: draft retained, sink untouched.
    expect(b.shell.snapshot.draft).toBe('/plan 上线')
    expect(b.sink).not.toHaveBeenCalled()
  })
})

describe('consume-token line guard (text-taking command actions)', () => {
  it('clears the whole draft when it still equals the adjudicated line (surrounding whitespace aside)', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/help how do I add a page?  ') })
    expect(b.shell.consumeToken({ kind: 'line', line: '/help how do I add a page?' })).toBe(true)
    expect(b.shell.snapshot.draft).toBe('')
  })

  it('leaves a draft that changed since adjudication alone', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/help how do I add a page? and a menu') })
    expect(b.shell.consumeToken({ kind: 'line', line: '/help how do I add a page?' })).toBe(false)
    expect(b.shell.snapshot.draft).toBe('/help how do I add a page? and a menu')
  })

  it('never clears on an empty line, and rides the scoped consume-token event like the other guards', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/help hi') })
    expect(b.shell.consumeToken({ kind: 'line', line: '' })).toBe(false)
    const actx = b.runtime.sessions.scope('scenario-s1' as SessionId)!
    expect(actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'line', line: '/help hi' } })).toBe(true)
    expect(b.shell.snapshot.draft).toBe('')
  })
})

describe('sent counter (Tracy: InputState.sent)', () => {
  it('starts at 0 and an empty Enter leaves it there', async () => {
    const b = await bench()
    expect(b.shell.state.getSnapshot().sent).toBe(0)
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.shell.state.getSnapshot().sent).toBe(0)
    expect(b.sink).not.toHaveBeenCalled()
  })

  it('counts an ordinary message once, when it goes out', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('change the footer phone') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.sink).toHaveBeenCalledTimes(1) })
    expect(b.shell.state.getSnapshot().sent).toBe(1)
  })

  it('counts a claimed command once it submits', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/goal 尽快发布') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.shell.snapshot.draft).toBe('') })
    expect(b.shell.state.getSnapshot().sent).toBe(1)
    expect(b.sink).not.toHaveBeenCalled()
  })

  it('counts every consumed command token (menu span, bare token, argued line), and no refused one', async () => {
    const b = await bench()
    const actx = b.runtime.sessions.scope('scenario-s1' as SessionId)!
    act(() => { b.shell.setDraft('/model') })
    const span = { start: 0, end: 6, draftRev: b.shell.snapshot.draftRev }
    expect(actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'span', span } })).toBe(true)
    expect(b.shell.state.getSnapshot().sent).toBe(1)
    act(() => { b.shell.setDraft('/export') })
    expect(actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'bare-token', token: '/export' } })).toBe(true)
    expect(b.shell.state.getSnapshot().sent).toBe(2)
    act(() => { b.shell.setDraft('/help how do I undo?') })
    expect(actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'line', line: '/help how do I undo?' } })).toBe(true)
    expect(b.shell.state.getSnapshot().sent).toBe(3)
    // A guard that no longer matches (the draft moved on, a stale span) consumes nothing and counts nothing.
    act(() => { b.shell.setDraft('/help how do I undo? and redo') })
    expect(b.shell.consumeToken({ kind: 'line', line: '/help how do I undo?' })).toBe(false)
    expect(b.shell.consumeToken({ kind: 'span', span })).toBe(false)
    expect(b.shell.state.getSnapshot().sent).toBe(3)
  })
})

describe('Tracy: a text-taking client action claims its token (help claim)', () => {
  /**
   * The ui-commands claim of a `takesText` action at the source boundary: menu pick and Space
   * return a claim whose submit runs the action locally with the trimmed text and settles success;
   * no Host execute, no default sink.
   */
  function helpSource(run: (text: string) => void) {
    const claim = (shown: string): CommandClaim => ({
      name: 'help',
      token: `/${shown} `,
      hint: 'ask about Tracy',
      submit: (args) => {
        run(args.trim())
        return Promise.resolve({ kind: 'success' })
      },
    })
    return {
      trigger: '/' as const,
      name: 'command',
      candidates: (_session: ClientSessionContext, req: { query: string }) =>
        Promise.resolve('help'.startsWith(req.query) ? [{ name: 'help', description: 'Ask' }] : []),
      onPick: (): PickOutcome => ({ claim: claim('help') }),
      matchSpace: (_session: ClientSessionContext, token: string): PickOutcome =>
        token.toLowerCase() === '/help' ? { claim: claim(token.slice(1)) } : undefined,
      matchEnter: (): Promise<PickOutcome> => Promise.resolve(undefined),
    }
  }

  it('a pick keeps "/help " styled with the ghost hint; Enter hands the question over, clears and counts once', async () => {
    const run = vi.fn()
    const b = await scopedBench((triggers) => { triggers.registerSource(helpSource(run)) })
    b.type('/he')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    act(() => { b.controller.pick('command', 0) })
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.shell.snapshot.draft).toBe('/help ')
    expect(run).not.toHaveBeenCalled()
    act(() => { b.shell.editor.update(() => {}, { discrete: true }) })
    expect(b.view.container.querySelector('[data-lexical-text][style*="business-primary"]')?.textContent).toBe('/help ')
    expect(b.textarea.style.getPropertyValue('--dsh-composer-hint')).toBe(JSON.stringify('ask about Tracy'))
    b.type('/help how do I undo?')
    expect(b.shell.snapshot.phase).toBe('claimed')
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.shell.snapshot.draft).toBe('') })
    expect(run).toHaveBeenCalledExactlyOnceWith('how do I undo?')
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.shell.state.getSnapshot().sent).toBe(1)
    expect(b.sink).not.toHaveBeenCalled()
  })

  it('Space after a typed /help claims it; Enter with nothing after the token runs the bare command', async () => {
    const run = vi.fn()
    const b = await scopedBench((triggers) => { triggers.registerSource(helpSource(run)) })
    b.type('/help')
    fireEvent.keyDown(b.textarea, { key: ' ', keyCode: 32 })
    // jsdom inserts no character for the key; the claim is what Space decided (scenario H does the same).
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.shell.snapshot.claim?.token).toBe('/help ')
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(run).toHaveBeenCalledExactlyOnceWith('') })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.shell.snapshot.draft.trim()).toBe('')
    expect(b.shell.state.getSnapshot().sent).toBe(1)
    expect(b.sink).not.toHaveBeenCalled()
  })
})
