import { PrismaClient } from "../../gp-api/node_modules/@prisma/client";
import { S3 } from "@aws-sdk/client-s3";
import { input as getInput } from "@inquirer/prompts";
import { searchNewRelicLogs } from "../utils/newrelic";
import { people } from "../utils/people";
import { pick } from "es-toolkit";

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

// yes, this very dumb
const dumbParseLogJson = (rawMessage: string): any =>
  JSON.parse(rawMessage.slice(rawMessage.indexOf("{")));

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

  const campaign = await prisma.campaign.findFirstOrThrow({
    where: {
      userId: user.id,
    },
  });

  console.log("Found campaign id:", campaign.id);

  const pathToVictory = await prisma.pathToVictory.findFirst({
    where: {
      campaignId: campaign.id,
    },
  });

  if (!pathToVictory) {
    console.log("No path to victory found");
  } else {
    console.log("Found path to victory id:", pathToVictory.id);
  }

  console.log("Path to victory: ", {
    state: campaign.details.state,
    districtId: pathToVictory?.data.districtId,
    districtType: pathToVictory?.data.electionType,
    districtName: pathToVictory?.data.electionLocation,
  });

  if (
    pathToVictory?.data.electionType &&
    pathToVictory?.data.electionLocation
  ) {
    const districtStats = await people.get("/v1/people/stats", {
      params: {
        state: campaign.details.state,
        districtType: pathToVictory?.data.electionType,
        districtName: pathToVictory?.data.electionLocation,
      },
    });

    console.log(
      "District stats:",
      pick(districtStats.data, [
        "districtId",
        "totalConstituents",
        "totalConstituentsWithCellPhone",
      ])
    );
  }

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

    const [res, individualMessageCount] = await Promise.all([
      s3.listObjectsV2({
        Bucket: "tevyn-poll-csvs-master",
        Prefix: poll.id,
      }),
      prisma.pollIndividualMessage.count({
        where: { pollId: poll.id },
      }),
    ]);
    console.log();
    console.log(`Has CSV: ${!!res.Contents?.length}`);
    console.log(`Individual messages: ${individualMessageCount}`);
    console.log("");

    const logs = await searchNewRelicLogs(
      `SELECT message FROM Log WHERE entity.name = 'GP_API' AND message LIKE '%Message processing failed%' AND message LIKE '%${poll.id}%' SINCE 1 week ago`
    );

    console.log("Background job failures:");
    console.log("--------------------------------");
    for (const log of logs) {
      const parsed = dumbParseLogJson(log.message);
      console.log(parsed);
      console.log();
    }
    console.log("--------------------------------");

    console.log();
  }
};
