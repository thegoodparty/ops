import type { ScriptContext } from 'swarm-sdk'
import * as z from 'zod'

// Tells the swarm where to answer a ClickUp comment mention. The trigger is a
// `taskCommentPosted` webhook body, which is untrusted input: it is parsed
// here, never trusted, and nothing in it is used but ids and a mention flag.
//
// ClickUp exposes one level of replies per comment thread. `GET
// /comment/{id}/threaded` on the thread's root returns the replies to the
// root, but not the replies to those replies, and the ticket view renders the
// same one level. So an answer posted on the reply that mentioned us lands one
// level too deep and the author never sees it: an answer always goes to the
// thread root, which is the triggering comment itself when the mention was a
// top-level comment.
//
// No token, no network call, no model: a caller posts to whatever this returns.

const DELEGATE_USER_ID = 118146002
const MENTION_TEXT = /@delegate\b/i

export const argsSchema = z.object({ payload: z.unknown() })

export type Target = {
  answer: boolean
  reason: string
  taskId: string | null
  commentId: string | null
  threadRootId: string | null
  replyToId: string | null
  authorId: number | null
}

const idSchema = z.union([z.string(), z.number()])

const blockSchema = z.object({
  user_mention: z
    .object({ name: z.string().optional(), id: idSchema.optional() })
    .optional(),
  user: z.object({ id: idSchema.optional() }).optional(),
})

const commentSchema = z.object({
  id: idSchema,
  comment: z.array(z.unknown()).nullish(),
  text_content: z.string().nullish(),
})

const historyItemSchema = z.object({
  user: z.object({ id: idSchema.optional() }).nullish(),
  comment: commentSchema,
  // Present when the event is a reply inside a thread, and then it carries
  // the thread's root comment. A root comment itself has no parent_comment.
  parent_comment: z.object({ id: idSchema }).nullish(),
})

const payloadSchema = z.object({
  task_id: idSchema.nullish(),
  history_items: z.array(z.unknown()).min(1),
})

const text = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value)

const integer = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return null
}

const no = (reason: string): Target => ({
  answer: false,
  reason,
  taskId: null,
  commentId: null,
  threadRootId: null,
  replyToId: null,
  authorId: null,
})

// A mention that appears only in `parent_comment` is not a mention of us on
// the reply: that parent was answered when it arrived, and answering it again
// here would post a second reply for one mention.
const mentionsDelegate = (comment: z.infer<typeof commentSchema>): boolean => {
  for (const raw of comment.comment ?? []) {
    const block = blockSchema.safeParse(raw)
    if (!block.success) continue
    if (block.data.user_mention?.name?.toLowerCase() === 'delegate') return true
    if (integer(block.data.user_mention?.id) === DELEGATE_USER_ID) return true
    if (integer(block.data.user?.id) === DELEGATE_USER_ID) return true
  }
  return MENTION_TEXT.test(comment.text_content ?? '')
}

export const resolveCommentTarget = (payload: unknown): Target => {
  const parsed = payloadSchema.safeParse(payload)
  if (!parsed.success) return no('malformed-payload')
  const item = historyItemSchema.safeParse(parsed.data.history_items[0])
  if (!item.success) return no('malformed-payload')

  // Our own comments are not a mention to answer, even when they name us.
  if (integer(item.data.user?.id) === DELEGATE_USER_ID)
    return no('author-is-delegate')
  if (!mentionsDelegate(item.data.comment)) return no('no-mention')

  const commentId = String(item.data.comment.id)
  const threadRootId = text(item.data.parent_comment?.id) ?? commentId
  return {
    answer: true,
    reason:
      threadRootId === commentId
        ? 'top-level-comment-mention'
        : 'threaded-reply-mention',
    taskId: text(parsed.data.task_id),
    commentId,
    threadRootId,
    replyToId: threadRootId,
    authorId: integer(item.data.user?.id),
  }
}

export default async function (
  args: z.infer<typeof argsSchema>,
  _ctx: ScriptContext,
): Promise<Target> {
  return resolveCommentTarget(args.payload)
}
