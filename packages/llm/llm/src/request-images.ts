/**
 * Read the request versions of retained images, surviving a lost stored copy in history.
 * Re-exported through `readRequestImages` in the package index, which raises the failure as an `LlmError`.
 * @module @deepseek-ai/dsh-llm/request-images
 */

import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { unavailableImageText } from './content.ts'
import { ATTACHMENT_MISSING_CODE, HarnessError } from './error.ts'
import type { ContentBlock, RequestMessage } from './types.ts'

type AttachmentKey = ImageAttachmentRef['attachmentId']

/** Attachment-store codes that mean the stored copy is gone or damaged for good. */
const LOST_IMAGE_CODES: ReadonlySet<string> = new Set(['ATTACHMENT_NOT_FOUND', 'ATTACHMENT_CORRUPT'])

/**
 * Attachment-store codes raised while reading one stored image. Matched by
 * code, not by class: `@deepseek-ai/dsh-attachment` is only a type dependency
 * of this package.
 */
const IMAGE_READ_CODES: ReadonlySet<string> = new Set([...LOST_IMAGE_CODES, 'ATTACHMENT_READ_FAILED', 'INVALID_ATTACHMENT_REF'])

function attachmentReadCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return undefined
  return IMAGE_READ_CODES.has(error.code) ? error.code : undefined
}

/** Retained images read for one request, with lost earlier images already replaced by notes. */
export interface RequestImages {
  /** Request history; the input list when nothing was replaced. */
  readonly messages: readonly RequestMessage[]
  /** Prepared request version of every image left in `messages`, keyed by attachment id. */
  readonly versions: Map<AttachmentKey, RequestImageAttachment>
}

/**
 * See `readRequestImages` in the package index.
 * @param messages - request history; never mutated.
 * @param read - read one reference's request version.
 * @returns history with lost earlier images replaced, and the versions of the others.
 * @throws {HarnessError} code `ATTACHMENT_MISSING`; other failures (cancellation) propagate unchanged.
 */
export async function readRetainedImages(
  messages: readonly RequestMessage[],
  read: (ref: ImageAttachmentRef) => Promise<RequestImageAttachment>,
): Promise<RequestImages> {
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const currentFrom = lastUser === -1 ? messages.length : lastUser
  const refs = new Map<AttachmentKey, { ref: ImageAttachmentRef; current: boolean }>()
  for (const [index, message] of messages.entries()) {
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue
      const seen = refs.get(block.attachment.attachmentId)
      refs.set(block.attachment.attachmentId, {
        ref: seen?.ref ?? block.attachment,
        current: seen?.current === true || index >= currentFrom,
      })
    }
  }
  const outcomes = await Promise.all([...refs.values()].map(({ ref, current }) => read(ref).then(
    version => ({ ref, current, version }),
    (error: unknown) => ({ ref, current, error }),
  )))
  const versions = new Map<AttachmentKey, RequestImageAttachment>()
  const lost = new Set<AttachmentKey>()
  for (const outcome of outcomes) {
    if ('version' in outcome) {
      versions.set(outcome.ref.attachmentId, outcome.version)
      continue
    }
    const code = attachmentReadCode(outcome.error)
    if (code === undefined) throw outcome.error
    if (!outcome.current && LOST_IMAGE_CODES.has(code)) {
      lost.add(outcome.ref.attachmentId)
      continue
    }
    const where = outcome.current ? 'attached to this message' : 'from earlier in this conversation'
    const name = outcome.ref.name ?? String(outcome.ref.attachmentId)
    throw new HarnessError(`An image ${where} is missing or unreadable: ${name} (${code}).`, ATTACHMENT_MISSING_CODE, { cause: outcome.error })
  }
  if (lost.size === 0) return { messages, versions }
  return { messages: messages.map(message => replaceLost(message, lost)), versions }
}

function replaceLost(message: RequestMessage, lost: ReadonlySet<AttachmentKey>): RequestMessage {
  let next: ContentBlock[] | undefined
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'image' && block.offloaded !== true && lost.has(block.attachment.attachmentId)) {
      next ??= message.content.slice(0, index)
      next.push({ type: 'text', text: unavailableImageText(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next === undefined ? message : { ...message, content: next }
}
