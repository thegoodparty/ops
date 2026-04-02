/**
 * Re-enqueue a POLL_EXPANSION message to the main SQS queue.
 *
 * Use when a poll expansion was purchased and the DB record was updated
 * (isCompleted=false, targetAudienceSize bumped) but the queue consumer
 * failed to process the expansion (e.g. transaction timeout, Slack failure).
 *
 * The queue consumer's triggerPollExecution is idempotent: it will reuse
 * an existing CSV in S3 and upsert individual messages.
 *
 * Usage:
 *   npm run script retrigger-poll-expansion <pollId>
 */

import { input as getInput } from '@inquirer/prompts'
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'

async function getPollId(): Promise<string> {
  const fromArgs = process.argv.at(3)?.trim()
  if (fromArgs) return fromArgs
  return getInput({
    message: 'Poll ID to retrigger expansion for',
    validate: (v) => (v.trim() ? true : 'Poll ID is required'),
  }).then((s) => s.trim())
}

async function main() {
  const pollId = await getPollId()

  const mainQueueUrl =
    'https://sqs.us-west-2.amazonaws.com/333022194791/master-Queue.fifo'

  const client = new SQSClient({
    region: process.env.AWS_REGION || 'us-west-2',
  })

  const messageBody = JSON.stringify({
    type: 'pollExpansion',
    data: { pollId },
  })

  const deduplicationId = `retrigger-expansion-${pollId}-${Date.now()}`

  console.log('Queue URL:', mainQueueUrl)
  console.log('Poll ID:', pollId)
  console.log('Message body:', messageBody)
  console.log('Message group ID:', `polls-${pollId}`)
  console.log('Deduplication ID:', deduplicationId)
  console.log()
  console.log('Sending POLL_EXPANSION message to main queue...')

  await client.send(
    new SendMessageCommand({
      QueueUrl: mainQueueUrl,
      MessageBody: messageBody,
      MessageGroupId: `polls-${pollId}`,
      MessageDeduplicationId: deduplicationId,
    }),
  )

  console.log('Message sent successfully.')
  console.log()
  console.log(
    'Monitor Grafana for processing logs. If the transaction times out',
  )
  console.log(
    'again, the timeout in triggerPollExecution needs to be increased.',
  )
}

export default main
