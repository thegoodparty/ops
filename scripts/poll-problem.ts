import { PrismaClient } from "../../gp-api/node_modules/@prisma/client";
import { S3 } from "@aws-sdk/client-s3";
import { input as getInput } from "@inquirer/prompts";
import { searchGrafanaLogs } from "../utils/grafana";

const prisma = new PrismaClient();

const s3 = new S3({ region: "us-west-2" });

const getUserFromPoll = async (pollId: string) => {
  const poll = await prisma.poll.findUniqueOrThrow({
    where: { id: pollId },
  });

  const electedOffice = await prisma.electedOffice.findUniqueOrThrow({
    where: { id: poll.electedOfficeId! },
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: electedOffice.userId! },
  });

  return user;
};

const getUser = async (input: string) => {
  if (input.length === 36) {
    console.log("Detected poll id, finding user");
    return getUserFromPoll(input);
  }
  if (input.includes("@")) {
    return prisma.user.findUniqueOrThrow({
      where: { email: input },
    });
  }

  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { slug: input },
  });

  return prisma.user.findFirstOrThrow({
    where: {
      id: campaign.userId,
    },
  });
};

export default async () => {
  const input =
    process.argv.at(3) ??
    (await getInput({
      message: "Enter any of the following: email, campaign slug, or poll id",
      default: process.argv.at(3),
    }));

  console.log("Input:", input);

  const user = await getUser(input);

  console.log("Found user id:", user.id);
  console.log("Found user email:", user.email);

  const org = await prisma.organization.findFirstOrThrow({
    where: {
      ownerId: user.id,
    },
  });

  console.log("Found org:", org);

  const campaign = await prisma.campaign.findFirstOrThrow({
    where: {
      userId: user.id,
    },
  });

  console.log("Found campaign id:", campaign.id);

  const electedOffice = await prisma.electedOffice.findFirst({
    where: {
      userId: user.id,
    },
  });

  if (!electedOffice) {
    console.log("No elected office found");
    return;
  }
  console.log("Found elected office id:", electedOffice.id);

  const polls = await prisma.poll.findMany({
    where: {
      electedOfficeId: electedOffice.id,
    },
  });

  console.log("Found polls:", polls.length);

  for (const poll of polls) {
    console.log(poll);

    const res = await s3.listObjectsV2({
      Bucket: "tevyn-poll-csvs-master",
      Prefix: poll.id,
    });
    console.log();
    console.log(`Has CSV: ${!!res.Contents?.length}`);
    console.log("");

    const grafanaLogs = await searchGrafanaLogs(
      `{service_name="gp-api"} |= "Message processing failed" |= "${poll.id}"`
    );

    console.log("Background job failures :");
    console.log("--------------------------------");
    for (const log of grafanaLogs) {
      console.log(JSON.parse(log.line));
      console.log();
    }
    console.log("--------------------------------");

    console.log();
  }
};
