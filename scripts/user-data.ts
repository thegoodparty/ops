import { PrismaClient } from "../../gp-api/node_modules/@prisma/client";
import { input as getInput } from "@inquirer/prompts";

const prisma = new PrismaClient();

export default async () => {
  const input =
    process.argv.at(3) ??
    (await getInput({
      message: "Enter user email or id:",
      default: process.argv.at(3),
    }));

  const user = await prisma.user.findUniqueOrThrow({
    where: input.includes("@") ? { email: input } : { id: Number(input) },
  });
  console.log("USER");
  console.log(user);

  const org = await prisma.organization.findFirstOrThrow({
    where: {
      ownerId: user.id,
    },
  });

  console.log("ORG");
  console.log(org);

  const campaign = await prisma.campaign.findFirst({
    where: {
      userId: user.id,
    },
  });

  console.log("CAMPAIGN");
  console.log(campaign);

  const electedOffice = await prisma.electedOffice.findFirst({
    where: {
      userId: user.id,
    },
  });

  console.log("ELECTED OFFICE");
  console.log(electedOffice);
};
