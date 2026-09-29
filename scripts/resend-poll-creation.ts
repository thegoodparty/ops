import { PrismaClient } from "../../gp-api/node_modules/@prisma/client";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { input as getInput, confirm } from "@inquirer/prompts";

const prisma = new PrismaClient();

// Resend a single Poll Creation message to the main queue.
// This is used to resend the message if it failed to send the first time.
// We need to resend the message to the main queue so that the poll creation process can continue.

// Production SQS config - matches gp-api queue.config.ts
const SQS_QUEUE = "master-Queue.fifo";
const SQS_QUEUE_BASE_URL = "https://sqs.us-west-2.amazonaws.com/333022194791";
const QUEUE_URL = `${SQS_QUEUE_BASE_URL}/${SQS_QUEUE}`;

const sqs = new SQSClient({ region: "us-west-2" });

export default async () => {
  const pollId =
    process.argv.at(3) ??
    (await getInput({
      message: "Enter the poll ID to resend the creation message for",
    }));

  // Verify the poll exists
  const poll = await prisma.poll.findUniqueOrThrow({
    where: { id: pollId },
  });

  console.log("Found poll:", {
    id: poll.id,
    isCompleted: poll.isCompleted,
    scheduledDate: poll.scheduledDate,
    estimatedCompletionDate: poll.estimatedCompletionDate,
    targetAudienceSize: poll.targetAudienceSize,
    electedOfficeId: poll.electedOfficeId,
  });

  const proceed = await confirm({
    message: `Send POLL_CREATION message to SQS for poll ${poll.id}?`,
    default: false,
  });

  if (!proceed) {
    console.log("Aborted.");
    return;
  }

  const body = JSON.stringify({
    type: "pollCreation",
    data: { pollId: poll.id },
  });

  const uuid = Math.random().toString(36).substring(2, 12);

  const command = new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: body,
    MessageDeduplicationId: uuid,
    MessageGroupId: `gp-queue-polls-${poll.id}`,
  });

  const result = await sqs.send(command);

  console.log("Message sent successfully!");
  console.log("MessageId:", result.MessageId);
  console.log("SequenceNumber:", result.SequenceNumber);
};
