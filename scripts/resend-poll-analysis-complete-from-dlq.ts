/**
 * Resend a single Poll Analysis Complete message from the DLQ to the main queue.
 *
 * Use when a poll completion job failed (e.g. findContacts failed due to
 * district change) and the event landed in the DLQ. Resending after fixing
 * the campaign's district allows the job to complete.
 *
 * Requires:
 *   - SQS_QUEUE_BASE_URL (e.g. https://sqs.us-west-2.amazonaws.com/333022194791)
 *   - SQS_QUEUE (main queue name, e.g. production-Queue.fifo)
 *   - SQS_DLQ_QUEUE (DLQ name, e.g. production-DLQ.fifo)
 *   - AWS credentials in env or default chain
 *
 * Usage:
 *   npm run resend-poll-from-dlq
 *   npm run resend-poll-from-dlq -- --poll-id=<pollId>
 *
 * If --poll-id is not provided, you will be prompted for the poll ID.
 */

import { input as getInput } from '@inquirer/prompts'
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'

const POLL_ANALYSIS_COMPLETE_TYPE = 'pollAnalysisComplete'
const MESSAGE_GROUP_ID = 'gp-queue-default'

function getEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `Missing env ${name}. Set it (e.g. in .env) and ensure it is loaded.`,
    )
  }
  return v
}

function parseArgs(): { pollId: string | null } {
  const arg = process.argv.find((a) => a.startsWith('--poll-id='))
  if (!arg) return { pollId: null }
  const pollId = arg.slice('--poll-id='.length).trim()
  return { pollId: pollId || null }
}

async function getPollId(): Promise<string> {
  const fromArgs = parseArgs().pollId
  if (fromArgs) return fromArgs
  return getInput({
    message: 'Poll ID (the poll whose pollAnalysisComplete message to resend from the DLQ)',
    validate: (v) => (v.trim() ? true : 'Poll ID is required'),
  }).then((s) => s.trim())
}

async function main() {
  const filterPollId = await getPollId()

  const baseUrl = getEnv('SQS_QUEUE_BASE_URL').replace(/\/$/, '')
  const mainQueueName = getEnv('SQS_QUEUE')
  const dlqName = process.env.SQS_DLQ_QUEUE || mainQueueName.replace('Queue', 'DLQ')
  const mainQueueUrl = `${baseUrl}/${mainQueueName}`
  const dlqUrl = `${baseUrl}/${dlqName}`

  const client = new SQSClient({
    region: process.env.AWS_REGION || 'us-west-2',
    ...(process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
  })

  console.log('DLQ URL:', dlqUrl)
  console.log('Main queue URL:', mainQueueUrl)
  console.log('Filtering for pollId:', filterPollId)
  console.log('Receiving messages from DLQ (batch size 10)...')

  let received = 0
  const maxBatches = 100 // avoid infinite loop; 100 * 10 = 1000 messages max

  for (let batch = 0; batch < maxBatches; batch++) {
    const { Messages } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60, // keep receipt handle valid long enough to send + delete
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    )

    if (!Messages?.length) {
      if (batch === 0) {
        console.log('No messages in DLQ (or queue empty).')
      }
      continue
    }

    for (const msg of Messages) {
      received++
      let body: unknown
      try {
        body = JSON.parse(msg.Body ?? '{}')
      } catch {
        continue
      }
      const type = (body as { type?: string }).type
      if (type !== POLL_ANALYSIS_COMPLETE_TYPE) continue

      const data = (body as { data?: { pollId?: string } }).data
      const pollId = data?.pollId
      if (filterPollId && pollId !== filterPollId) continue

      console.log('Found matching message:', { pollId, receiptHandle: msg.ReceiptHandle?.slice(0, 20) + '...' })

      const deduplicationId = Math.random().toString(36).substring(2, 12)
      await client.send(
        new SendMessageCommand({
          QueueUrl: mainQueueUrl,
          MessageBody: msg.Body!,
          MessageGroupId: `polls-${pollId}`,
          MessageDeduplicationId: deduplicationId,
        }),
      )
      console.log('Sent to main queue with MessageDeduplicationId:', deduplicationId)

      await client.send(
        new DeleteMessageCommand({
          QueueUrl: dlqUrl,
          ReceiptHandle: msg.ReceiptHandle!,
        }),
      )
      console.log('Deleted from DLQ. Done.')
      process.exit(0)
    }
  }

  console.log('Stopped after', maxBatches, 'batches. No matching message found.')
  console.log('Ensure the poll ID is correct and the message is in the DLQ.')
  process.exit(1)
}

export default main
