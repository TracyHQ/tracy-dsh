/** Interleave client-local rows into the log entries of the Chat view. */
import type { RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatLocalNode } from '../contract/chat-local.ts'

/** A log entry, or a client-local row drawn among them. */
export type ViewEntry = RenderEntry | { readonly kind: 'local'; readonly node: ChatLocalNode }

/**
 * Each local row goes before the first log entry whose seq is greater than its
 * `anchorSeq` (after every entry at or below it), so a row the agent has since
 * written past stays above the agent's newer rows. Local rows are already in
 * `anchorSeq` order.
 * @param entries - log entries in presentation order.
 * @param rows - local rows in draw order.
 * @param seqOf - seq a log entry sits at (`-1` when unknown).
 * @returns `entries` itself when there are no local rows, else the merged list.
 */
export function withLocalRows(
  entries: readonly RenderEntry[],
  rows: readonly ChatLocalNode[],
  seqOf: (entry: RenderEntry) => number,
): readonly ViewEntry[] {
  if (rows.length === 0) return entries
  const merged: ViewEntry[] = []
  let next = 0
  for (const entry of entries) {
    const seq = seqOf(entry)
    while (next < rows.length && rows[next]!.anchorSeq < seq) merged.push({ kind: 'local', node: rows[next++]! })
    merged.push(entry)
  }
  while (next < rows.length) merged.push({ kind: 'local', node: rows[next++]! })
  return merged
}
