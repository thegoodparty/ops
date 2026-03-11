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

  const campaign = await prisma.campaign.findFirst({
    where: {
      userId: user.id,
    },
    include: { pathToVictory: true },
  });
  console.log(user);

  console.log(campaign);
};
