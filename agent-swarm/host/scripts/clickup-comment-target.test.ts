import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCommentTarget } from './clickup-comment-target'

// Shapes copied from a real `taskCommentPosted` delivery: a reply in a
// thread, authored by a person, whose body mentions the Delegate bot.
const TASK_ID = '17tnw2b5rd0'
const ROOT_COMMENT_ID = '1400430000339945'
const REPLY_ID = '1400430000348823'
const TOP_COMMENT_ID = '1400430000348875'
const AUTHOR_ID = 168143924
const DELEGATE_ID = 118146002
const DELEGATE_MENTION_TEXT = ' please run the box skill on this ticket.\n@delegate'

const mentionBlock = () => ({
  type: 'user_mention',
  attributes: {},
  user_mention: { id: String(DELEGATE_ID), notify: true, name: 'delegate' },
  user: { id: DELEGATE_ID, username: 'delegate' },
  text: '@delegate',
})

const payload = (options: {
  commentId: string
  replyTo?: string
  authorId?: number
  blocks?: unknown[]
  textContent?: string
  parentTextContent?: string
  includeParentComment?: boolean
}) => {
  const { commentId, replyTo } = options
  const comment: Record<string, unknown> = {
    id: commentId,
    parent: replyTo ?? TASK_ID,
    type: replyTo === undefined ? 1 : 2,
    comment: options.blocks ?? [],
    text_content: options.textContent ?? '',
    is_private: false,
    root_parent_id: TASK_ID,
    root_parent_type: 1,
  }
  const item: Record<string, unknown> = {
    id: '853cb263-5f5c-4f05-87d3-515211c774ce',
    type: 2,
    date: '1794507766770',
    field: 'comment',
    parent_id: '901327608453',
    after: commentId,
    user: {
      id: options.authorId ?? AUTHOR_ID,
      username: 'Swain Molster',
      email: 'swain@goodparty.org',
    },
    comment,
  }
  if (replyTo !== undefined && options.includeParentComment !== false) {
    item.parent_comment = {
      id: replyTo,
      parent: TASK_ID,
      type: 1,
      text_content: options.parentTextContent ?? DELEGATE_MENTION_TEXT,
    }
  }
  return {
    event: 'taskCommentPosted',
    task_id: TASK_ID,
    history_items: [item],
  }
}

describe('clickup-comment-target', () => {
  it('answers a threaded reply at the thread root, not on the reply', () => {
    const target = resolveCommentTarget(
      payload({
        commentId: REPLY_ID,
        replyTo: ROOT_COMMENT_ID,
        blocks: [
          mentionBlock(),
          {
            text: ' thanks. That page is at the wrong altitude, so set it aside.',
            attributes: {},
          },
        ],
        textContent:
          ' thanks. That page is at the wrong altitude, so set it aside.\n@delegate',
      }),
    )
    assert.deepEqual(target, {
      answer: true,
      reason: 'threaded-reply-mention',
      taskId: TASK_ID,
      commentId: REPLY_ID,
      threadRootId: ROOT_COMMENT_ID,
      replyToId: ROOT_COMMENT_ID,
      authorId: AUTHOR_ID,
    })
    // The regression: a reply posted on the reply is one level too deep.
    assert.notEqual(target.replyToId, target.commentId)
  })

  it('answers a top-level comment at itself', () => {
    assert.deepEqual(
      resolveCommentTarget(
        payload({
          commentId: TOP_COMMENT_ID,
          blocks: [mentionBlock()],
          textContent: DELEGATE_MENTION_TEXT,
        }),
      ),
      {
        answer: true,
        reason: 'top-level-comment-mention',
        taskId: TASK_ID,
        commentId: TOP_COMMENT_ID,
        threadRootId: TOP_COMMENT_ID,
        replyToId: TOP_COMMENT_ID,
        authorId: AUTHOR_ID,
      },
    )
  })

  it('answers a comment whose mention is only in its text', () => {
    const target = resolveCommentTarget(
      payload({
        commentId: TOP_COMMENT_ID,
        blocks: [{ text: DELEGATE_MENTION_TEXT, attributes: {} }],
        textContent: DELEGATE_MENTION_TEXT,
      }),
    )
    assert.equal(target.answer, true)
    assert.equal(target.reason, 'top-level-comment-mention')
  })

  it('does not answer our own comment', () => {
    assert.deepEqual(
      resolveCommentTarget(
        payload({
          commentId: REPLY_ID,
          replyTo: ROOT_COMMENT_ID,
          authorId: DELEGATE_ID,
          blocks: [mentionBlock()],
          textContent: DELEGATE_MENTION_TEXT,
        }),
      ),
      {
        answer: false,
        reason: 'author-is-delegate',
        taskId: null,
        commentId: null,
        threadRootId: null,
        replyToId: null,
        authorId: null,
      },
    )
  })

  it('does not answer a threaded reply with no mention', () => {
    const target = resolveCommentTarget(
      payload({
        commentId: REPLY_ID,
        replyTo: ROOT_COMMENT_ID,
        blocks: [{ text: ' set it aside.', attributes: {} }],
        textContent: ' set it aside.',
      }),
    )
    assert.equal(target.answer, false)
    assert.equal(target.reason, 'no-mention')
    assert.equal(target.replyToId, null)
  })

  it('does not answer a reply whose parent mentions us but whose body does not', () => {
    const target = resolveCommentTarget(
      payload({
        commentId: REPLY_ID,
        replyTo: ROOT_COMMENT_ID,
        parentTextContent: DELEGATE_MENTION_TEXT,
        blocks: [{ text: ' set it aside.', attributes: {} }],
        textContent: ' set it aside.',
      }),
    )
    assert.equal(target.answer, false)
    assert.equal(target.reason, 'no-mention')
  })

  it('does not throw or answer on a malformed payload', () => {
    for (const bad of [
      undefined,
      null,
      {},
      'not json',
      { history_items: 'nope' },
      { history_items: [] },
      { history_items: [{}] },
      { history_items: [{ comment: {} }] },
      { history_items: [{ comment: { id: REPLY_ID }, parent_comment: {} }] },
    ]) {
      const target = resolveCommentTarget(bad)
      assert.equal(target.answer, false, JSON.stringify(bad))
      assert.equal(target.reason, 'malformed-payload', JSON.stringify(bad))
      assert.equal(target.taskId, null)
      assert.equal(target.commentId, null)
      assert.equal(target.replyToId, null)
    }
  })
})
