/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * rightbar), the drag handles (pointer capture + rAF throttle), the column
 * solve (columns.ts), and the child-slot render decisions: the sidebar slot
 * receives live parameters from that solve. The root-scoped main slot selects
 * the Conversation or a global panel. Each column occupant owns its Session
 * binding and reports the geometry it needs.
 *
 * The right column is a track, not a box: its occupant draws its panel anchored
 * to the frame's right edge at the resolved normal width, and the
 * track only decides whether the centre makes room for it. The occupant reports
 * shown/track/fullscreen through `ctx.layout`; fullscreen keeps the reported
 * track but hides the outer resize handle. Everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  CHAT_COMPACT_FRAME, CHAT_DEFAULT_MIN, CHAT_MIN, chatDefault, chatRange, clampChat, computeColumns,
  RIGHTBAR_DRAG_MIN, RIGHTBAR_MAX_RATIO, RIGHTBAR_NO_CEILING, RIGHTBAR_PREFERRED, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT, sidebarTrack,
} from './columns.ts'
import { CHAT_WIDTH_KEY, parseChatWidth, writeChatWidth } from './chat-width.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Arrow-key step of the Conversation divider, in px. */
const CHAT_KEY_STEP = 16

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay' | 'shell.leading'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * Right column grid item. Zero-width unless the occupant asked for a track; the
 * occupant's panel is positioned against the column's right edge, which never
 * moves, so it can hang over the centre when there is no track.
 */
function RightbarColumn(props: { children?: ReactNode }) {
  return <div className={css.rightbarCol} data-rightbar-col>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: {
  side: 'sidebar' | 'rightbar'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
  /** Keyboard and reset affordances; present only on a handle that has them. */
  separator?: {
    label: string
    now: number
    min: number
    max: number
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
    onReset: () => void
  }
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || capture.current !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    capture.current = { element: e.currentTarget, id: e.pointerId }
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    callbacks.current.onDrag(e.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === e.pointerId) endDrag()
  }, [endDrag])

  const separator = props.separator
  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      {...(separator === undefined ? {} : {
        'role': 'separator',
        'aria-orientation': 'vertical' as const,
        'aria-label': separator.label,
        'aria-valuenow': separator.now,
        'aria-valuemin': separator.min,
        'aria-valuemax': separator.max,
        'tabIndex': 0,
        'onKeyDown': separator.onKeyDown,
        'onDoubleClick': separator.onReset,
      })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/**
 * The CSS custom properties the track formula in AppFrame.module.css reads,
 * written as browser expressions of the frame width (`100%`) so that the
 * browser keeps them right through a window resize before the next JS solve.
 * @param viewport - frame width in px; a compact frame gets px values.
 * @param sidebar - sidebar track width in px.
 * @param chat - the dragged Conversation width in px, or null for the default.
 * @param preferred - the right panel's preferred width in px.
 * @param track - whether the right panel takes a grid track.
 * @param ceiling - the widest the right panel may be, in px (RIGHTBAR_NO_CEILING for none).
 * @returns the custom property map.
 */
function frameTrackInputs(
  viewport: number, sidebar: number, chat: number | null, preferred: number, track: boolean, ceiling: number,
): Record<string, string> {
  const usable = `(100% - ${sidebar}px)`
  const compact = viewport <= CHAT_COMPACT_FRAME
  const capped = Number.isFinite(ceiling)
  const panelDefault = Math.min(preferred, ceiling)
  // Tracy: an unbounded preferred width (RIGHTBAR_PREFERRED) leaves the Conversation at its floor.
  const defaultChat = compact ? `${CHAT_MIN}px`
    : Number.isFinite(panelDefault) ? `max(${CHAT_DEFAULT_MIN}px, calc(${usable} - ${panelDefault}px))` : `${CHAT_DEFAULT_MIN}px`
  const unbounded = `max(${RIGHTBAR_MAX_RATIO * 100}%, calc(${usable} - ${defaultChat}))`
  // Tracy: a ceiling raises the Conversation's floor, which clamp() lets win over the drag ceiling.
  const widest = capped ? `min(${unbounded}, ${ceiling}px)` : unbounded
  return {
    '--dsh-frame-sidebar': `${sidebar}px`,
    '--dsh-frame-chat': chat === null ? defaultChat : `${Math.max(CHAT_MIN, Math.round(chat))}px`,
    '--dsh-frame-chat-min': `${CHAT_MIN}px`,
    '--dsh-frame-chat-lo': `max(${CHAT_MIN}px, calc(${usable} - ${widest}))`,
    '--dsh-frame-chat-hi': `calc(${usable} - ${RIGHTBAR_DRAG_MIN}px)`,
    '--dsh-frame-rightbar-track': track ? '1' : '0',
  }
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  usePanelInfo,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const layoutInfo = useStore(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : layoutInfo.sidebar
  // Tracy (14/10/2026): a tab's preferred width no longer sizes the panel; every tab opens beside
  // the same narrow Conversation (columns.ts). layoutInfo.rightbarPreferred is still recorded.
  const preferred = RIGHTBAR_PREFERRED
  // Tracy: the active tab's ceiling, applied on every read; the stored Conversation width is untouched.
  const ceiling = layoutInfo.rightbarMax ?? RIGHTBAR_NO_CEILING
  // Desktop reopen controls occupy the frame's shell.leading seat (macOS) or
  // the Windows caption row; neither platform keeps an icon rail.
  const darwin = document.documentElement.dataset.platform === 'darwin'
  // An embedding desktop shell whose sidebar occupant keeps an icon rail when collapsed marks
  // <html data-desktop-sidebar-rail>: the collapsed column keeps the rail width on macOS too, and the
  // occupant clears the traffic lights itself, so the shell.leading seat stays unmounted.
  const railKept = darwin && document.documentElement.hasAttribute('data-desktop-sidebar-rail')
  const collapsedWidth = (darwin && !railKept)
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED
  // Opening on a narrow frame collapses the left sidebar. Eligibility must
  // include that space before the occupant's first shown report arrives.
  // Until the user drags the divider, the Conversation takes what the right
  // panel's preferred width leaves; the default follows the sidebar it sits beside.
  const chatFor = (sidebar: number) => layoutInfo.chat ?? chatDefault(viewport, sidebarTrack(sidebar, collapsedWidth), preferred, ceiling)
  const normalSidebar = !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference
  const normal = computeColumns(viewport, normalSidebar, chatFor(normalSidebar), collapsedWidth, preferred, ceiling)
  const cols = computeColumns(viewport, sidebarPreference, layoutInfo.rightbarTrack ? chatFor(sidebarPreference) : null, collapsedWidth, preferred, ceiling)
  const colsRef = useRef(cols)
  colsRef.current = cols
  // The Conversation width beside the open right panel, as rendered.
  const chatWidth = useRef(normal.center)
  chatWidth.current = normal.center
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const preferredRef = useRef(preferred)
  preferredRef.current = preferred
  const ceilingRef = useRef(ceiling)
  ceilingRef.current = ceiling

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const chatBase = useRef(0)
  // The width the current chat drag last asked for; saved once, on release.
  const chatDragged = useRef<number | null>(null)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  // Track easing is scoped to a discrete open/close toggle: data-animating
  // goes up when the collapse state or the rightbar track flips and comes down
  // at transition end (timeout as the reduced-motion/covered-frame fallback).
  // Steady-state viewport updates stay instant (AppFrame.module.css), and so
  // does a toggle arriving together with a viewport change — that is the
  // responsive auto-collapse firing mid window-resize, where easing would
  // chase the live window edge. The counter restarts the settle window when a
  // re-toggle interrupts a running transition.
  const [animating, setAnimating] = useState(0)
  // A switch between right-panel tabs that prefer different widths moves the
  // default divider; it eases like a toggle until the user has dragged it. A
  // switch between tabs with different ceilings eases the same way.
  const trackToggle = `${sidebarCollapsed}:${layoutInfo.rightbarTrack}:${layoutInfo.chat === null ? preferred : 'dragged'}:${ceiling}`
  const previousToggle = useRef(trackToggle)
  const previousViewport = useRef(viewport)
  useLayoutEffect(() => {
    const viewportChanged = previousViewport.current !== viewport
    previousViewport.current = viewport
    if (previousToggle.current === trackToggle) return
    previousToggle.current = trackToggle
    if (viewportChanged) return
    setAnimating(token => token + 1)
  }, [trackToggle, viewport])
  useEffect(() => {
    if (animating === 0) return
    const frame = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (frame === null) return
    const settle = () => { setAnimating(0) }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === frame && event.propertyName === 'grid-template-columns') settle()
    }
    frame.addEventListener('transitionend', onTransitionEnd)
    const timer = setTimeout(settle, 600)
    return () => {
      frame.removeEventListener('transitionend', onTransitionEnd)
      clearTimeout(timer)
    }
  }, [animating])
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onChatStart = useCallback(() => {
    chatBase.current = chatWidth.current
    chatDragged.current = null
    setDragging(true)
  }, [])
  const onChatDrag = useCallback((dx: number) => {
    // Tracy: under a ceiling, a press that never moved keeps the width the user chose for other tabs.
    if (dx === 0 && chatDragged.current === null && Number.isFinite(ceilingRef.current)) return
    chatDragged.current = clampChat(chatBase.current + dx, viewportRef.current, colsRef.current.sidebar, preferredRef.current, ceilingRef.current)
    actions.setChat(chatDragged.current)
  }, [actions])
  // Saved on release, not per frame: the drag writes the store at pointer cadence.
  const onChatEnd = useCallback(() => {
    setDragging(false)
    if (chatDragged.current !== null) writeChatWidth(chatDragged.current)
    chatDragged.current = null
  }, [])
  const onChatReset = useCallback(() => {
    actions.resetChat()
    writeChatWidth(null)
  }, [actions])
  const onChatKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = chatWidth.current
    const range = chatRange(viewportRef.current, colsRef.current.sidebar, preferredRef.current, ceilingRef.current)
    const target = e.key === 'ArrowLeft' ? current - CHAT_KEY_STEP
      : e.key === 'ArrowRight' ? current + CHAT_KEY_STEP
        : e.key === 'Home' ? range.min
          : e.key === 'End' ? range.max
            : e.key === 'Enter' ? null
              : undefined
    if (target === undefined) return
    e.preventDefault()
    e.stopPropagation()
    if (target === null) { onChatReset(); return }
    const px = clampChat(target, viewportRef.current, colsRef.current.sidebar, preferredRef.current, ceilingRef.current)
    actions.setChat(px)
    writeChatWidth(px)
  }, [actions, onChatReset])
  // Another tab of this browser saved or forgot a width: follow it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== CHAT_WIDTH_KEY) return
      const px = parseChatWidth(e.key === null ? null : e.newValue)
      if (px === null) actions.resetChat()
      else actions.setChat(px)
    }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage) }
  }, [actions])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')
  // The rendered template lets the grid solve the squeeze natively: the centre
  // declares its protected minimum and the right column bids up to the clamped
  // preference, so a window resize lands in the same layout pass as the frame
  // edge. The JS solve lags the viewport by a ResizeObserver + rAF frame; when
  // it priced the squeeze itself, the centre column absorbed each width change
  // whole and was corrected two frames later — visible jitter. cols keeps only
  // the discrete decisions (track present, collapse state) and the drag base.
  // Inputs of the track formula in AppFrame.module.css. The browser computes
  // the default Conversation width and clamps a dragged one itself (both
  // mirroring columns.ts), so a window resize needs no JS round trip; the JS
  // solve only decides whether the right track exists.
  const frameTracks = frameTrackInputs(viewport, cols.sidebar, layoutInfo.chat, preferred, cols.rightbar > 0, ceiling)
  const sidebar = useMemo(() => renderSlot('sidebar', {
    collapsed: sidebarCollapsed,
    width: cols.sidebar,
  }), [renderSlot, sidebarCollapsed, cols.sidebar])
  const main = useMemo(() => (
    <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
  ), [usePanelInfo, renderSlot])
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])
  // Window-chrome seat over the main panels' top-left corner: only a fully
  // hidden sidebar column on macOS desktop leaves window chrome without a
  // home — the Windows zero-width collapse keeps its controls in the caption
  // row (ui-sidebar). AppFrame.module.css publishes the matching
  // --dsh-frame-leading-clearance under the same collapsed condition.
  const leading = useMemo(() => renderSlot('shell.leading', {}), [renderSlot])
  const leadingMounted = darwin && sidebarCollapsed && !railKept

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        ...(document.documentElement.hasAttribute('data-windows-titlebar')
          ? { '--dsh-windows-sidebar-width': `${cols.sidebar}px` } : {}),
        ...frameTracks,
      } as CSSProperties}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      data-rightbar-instant={layoutInfo.rightbarInstant || undefined}
      data-dragging={dragging || undefined}
      data-animating={animating > 0 || undefined}
    >
      <DocumentTitle
        productTitle={productTitle}
        useSessions={useSessions}
        usePanelInfo={usePanelInfo}
      />
      <div className={css.sidebarCol}>
        {sidebar}
      </div>
      <>
        <CenterColumn>{main}</CenterColumn>
        <RightbarColumn>
          {renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 })}
        </RightbarColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
      {leadingMounted && (
        <div className={css.leadingSeat} data-shell-leading>
          {leading}
        </div>
      )}
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <DragHandle
          side="rightbar"
          left={viewport - normal.rightbar}
          onStart={onChatStart}
          onDrag={onChatDrag}
          onEnd={onChatEnd}
          separator={{
            label: t('layout.resizeChat'),
            now: normal.center,
            ...chatRange(viewport, normal.sidebar, preferred, ceiling),
            onKeyDown: onChatKey,
            onReset: onChatReset,
          }}
        />
      )}
    </div>
  )
}
