import { describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationTimelineSnapshot, RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createChatLocal } from '../src/client/chat-local.ts'
import { withLocalRows } from '../src/client/chat/local-rows.ts'
import type { ChatLocalNode } from '../src/client/contract/chat-local.ts'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

const timeline: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }
const SID = 's1' as SessionId

function logNode(seq: number): ChatConversationViewNode {
  return {
    key: `user:${String(seq)}`, id: String(seq), target: 'chat', kind: 'user', anchorSeq: seq,
    location: { kind: 'session' }, visibility: 'visible',
    data: { kind: 'user', messageId: `m-${String(seq)}`, seq, time: seq, content: [{ type: 'text', text: 'hi' }], source: null },
  }
}

/** A chat-local service reading the snapshot of `builder`; no snapshot for other sessions. */
function bench(seqs: readonly number[] = []) {
  const builder = new ChatSnapshotBuilder()
  let snapshot = builder.replace({ nodes: seqs.map(logNode), timeline })
  const service = createChatLocal(id => id === SID ? snapshot : undefined)
  return {
    service, session: service.for(SID), snapshot: () => snapshot,
    replace: (next: readonly number[]) => { snapshot = builder.replace({ nodes: next.map(logNode), timeline }) },
  }
}

const input = (id: string, anchorSeq: number) => ({ id, kind: 'unknown', anchorSeq, data: { id } }) as never
const ids = (rows: readonly ChatLocalNode[]) => rows.map(row => row.id)

describe('createChatLocal', () => {
  it('keeps rows in anchor order, ties by first insertion; upsert replaces in place', () => {
    const { session } = bench()
    session.upsert(input('b', 5))
    session.upsert(input('a', 2))
    session.upsert(input('c', 5))
    expect(ids(session.nodes.getSnapshot())).toEqual(['a', 'b', 'c'])
    session.upsert({ id: 'b', kind: 'unknown', anchorSeq: 5, data: { id: 'b2' } } as never)
    const rows = session.nodes.getSnapshot()
    expect(ids(rows)).toEqual(['a', 'b', 'c'])
    expect(rows[1]!.data).toEqual({ id: 'b2' })
    // Moving the anchor re-sorts the row.
    session.upsert(input('b', 1))
    expect(ids(session.nodes.getSnapshot())).toEqual(['b', 'a', 'c'])
  })

  it('stamps rows as visible chat nodes under a prefixed key that no log key can collide with', () => {
    const { session } = bench([1])
    session.upsert(input('q', 1))
    expect(session.nodes.getSnapshot()[0]).toMatchObject({
      key: 'local:q', id: 'q', target: 'chat', anchorSeq: 1, visibility: 'visible', location: { kind: 'session' },
    })
  })

  it('remove drops one row, ignores unknown ids and stays quiet when nothing changed; clear drops all', () => {
    const { session } = bench()
    session.upsert(input('a', 1))
    session.upsert(input('b', 2))
    const listener = vi.fn()
    session.nodes.subscribe(listener)
    session.remove('nope')
    expect(listener).not.toHaveBeenCalled()
    session.remove('a')
    expect(ids(session.nodes.getSnapshot())).toEqual(['b'])
    session.clear()
    expect(session.nodes.getSnapshot()).toEqual([])
    const calls = listener.mock.calls.length
    session.clear()
    expect(listener.mock.calls.length).toBe(calls)
  })

  it('serves one list per session and the same list on every call', () => {
    const { service, session } = bench()
    session.upsert(input('a', 1))
    expect(service.for(SID)).toBe(session)
    expect(service.for('other' as SessionId).nodes.getSnapshot()).toEqual([])
  })

  it('tailSeq is the largest anchor of the session\'s chat nodes, -1 when it has none or is unknown', () => {
    const { service, session, replace } = bench()
    expect(session.tailSeq()).toBe(-1)
    replace([3, 9, 4])
    expect(session.tailSeq()).toBe(9)
    replace([3, 9, 12])
    expect(session.tailSeq()).toBe(12)
    expect(service.for('other' as SessionId).tailSeq()).toBe(-1)
  })

  it('local rows never reach the chat snapshot: nodes, order and tailSeq are untouched', () => {
    const { session, snapshot } = bench([1, 2])
    const before = snapshot()
    session.upsert(input('q', 99))
    expect(snapshot()).toBe(before)
    expect(snapshot().nodes.values().map(node => node.key)).toEqual(['user:1', 'user:2'])
    expect(snapshot().nodes.get('local:q')).toBeUndefined()
    expect(snapshot().order).not.toContain('local:q')
    expect(session.tailSeq()).toBe(2)
  })
})

describe('withLocalRows', () => {
  const entries = (seqs: readonly number[]): RenderEntry[] => seqs.map(seq => ({ kind: 'node', key: `n${String(seq)}` }) as RenderEntry)
  const seqOf = (entry: RenderEntry): number => Number((entry as { key: string }).key.slice(1))
  const rows = (...anchors: readonly number[]): ChatLocalNode[] => anchors.map((anchorSeq, index) => ({
    key: `local:r${String(index)}`, id: `r${String(index)}`, kind: 'unknown', target: 'chat', anchorSeq,
    location: { kind: 'session' }, visibility: 'visible', data: {}, order: index + 1,
  }) as never)
  const shape = (merged: ReturnType<typeof withLocalRows>): string[] =>
    merged.map(entry => entry.kind === 'local' ? entry.node.id : (entry as { key: string }).key)

  it('without local rows hands back the very same entries', () => {
    const log = entries([1, 2, 3])
    expect(withLocalRows(log, [], seqOf)).toBe(log)
  })

  it('places a row after every entry with seq <= anchor and before the greater ones', () => {
    expect(shape(withLocalRows(entries([1, 2, 5, 6]), rows(2), seqOf))).toEqual(['n1', 'n2', 'r0', 'n5', 'n6'])
    // An agent entry generated later (greater seq) sits below the row.
    expect(shape(withLocalRows(entries([1, 2, 7]), rows(2), seqOf))).toEqual(['n1', 'n2', 'r0', 'n7'])
  })

  it('handles anchors before the first entry, equal to the tail, beyond it, and empty logs', () => {
    expect(shape(withLocalRows(entries([3, 4]), rows(-1), seqOf))).toEqual(['r0', 'n3', 'n4'])
    expect(shape(withLocalRows(entries([3, 4]), rows(4), seqOf))).toEqual(['n3', 'n4', 'r0'])
    expect(shape(withLocalRows(entries([3, 4]), rows(40), seqOf))).toEqual(['n3', 'n4', 'r0'])
    expect(shape(withLocalRows([], rows(1, 2), seqOf))).toEqual(['r0', 'r1'])
  })

  it('keeps several rows in the order given, interleaved with the log by anchor', () => {
    expect(shape(withLocalRows(entries([1, 3, 5]), rows(1, 1, 3, 9), seqOf)))
      .toEqual(['n1', 'r0', 'r1', 'n3', 'r2', 'n5', 'r3'])
  })

  it('an entry with an unknown seq (-1) counts as below every anchor', () => {
    const merged = withLocalRows(entries([1, 2]), rows(0), entry => seqOf(entry) === 1 ? -1 : 2)
    expect(shape(merged)).toEqual(['n1', 'r0', 'n2'])
  })
})
