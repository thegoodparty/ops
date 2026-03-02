import { PrismaClient } from "../../gp-api/node_modules/@prisma/client";
import { input as getInput, confirm } from "@inquirer/prompts";

const prisma = new PrismaClient();

// Move polls from one user to another
// This is used to fix the case where a user has the wrong email and the poll is associated with the wrong user
// We need to move the poll to the correct user
// We also need to delete the accidental campaign(s) from the correct user
// We also need to transfer the campaign(s) from the wrong user to the correct user
// We also need to transfer the elected offices & polls from the wrong user to the correct user
// We also need to delete the wrong-email user

export default async () => {
  const wrongEmail =
    process.argv.at(3) ??
    (await getInput({
      message: "Enter the WRONG email (the user account that has the poll)",
    }));

  const correctEmail =
    process.argv.at(4) ??
    (await getInput({
      message:
        "Enter the CORRECT email (the user who signed up and should own the poll)",
    }));

  // --- Fetch both users ---
  const wrongUser = await prisma.user.findUnique({
    where: { email: wrongEmail },
  });
  if (!wrongUser) {
    console.error(`No user found with email: ${wrongEmail}`);
    return;
  }

  const correctUser = await prisma.user.findUnique({
    where: { email: correctEmail },
  });
  if (!correctUser) {
    console.error(`No user found with email: ${correctEmail}`);
    return;
  }

  if (wrongUser.id === correctUser.id) {
    console.error(
      `Both emails resolve to the same user (${wrongUser.id}). Use two different users to run this script.`,
    );
    return;
  }

  console.log("\n--- Wrong email user (has the poll) ---");
  console.log(`  ID: ${wrongUser.id}`);
  console.log(`  Email: ${wrongUser.email}`);
  console.log(
    `  Name: ${wrongUser.name ?? `${wrongUser.firstName} ${wrongUser.lastName}`}`,
  );

  console.log("\n--- Correct email user (should own the poll) ---");
  console.log(`  ID: ${correctUser.id}`);
  console.log(`  Email: ${correctUser.email}`);
  console.log(
    `  Name: ${correctUser.name ?? `${correctUser.firstName} ${correctUser.lastName}`}`,
  );

  // --- Show what the wrong user owns ---
  const wrongUserCampaigns = await prisma.campaign.findMany({
    where: { userId: wrongUser.id },
    select: { id: true, slug: true, createdAt: true },
  });
  const wrongUserElectedOffices = await prisma.electedOffice.findMany({
    where: { userId: wrongUser.id },
    select: { id: true, campaignId: true, isActive: true },
  });
  const wrongUserPolls = await prisma.poll.findMany({
    where: {
      electedOfficeId: { in: wrongUserElectedOffices.map((eo) => eo.id) },
    },
    select: { id: true, name: true, isCompleted: true, electedOfficeId: true },
  });

  console.log("\n--- Wrong user's data ---");
  console.log(`  Campaigns: ${wrongUserCampaigns.length}`);
  for (const c of wrongUserCampaigns) {
    console.log(
      `    - ${c.id} (slug: ${c.slug}, created: ${c.createdAt.toISOString()})`,
    );
  }
  console.log(`  Elected offices: ${wrongUserElectedOffices.length}`);
  for (const eo of wrongUserElectedOffices) {
    console.log(
      `    - ${eo.id} (campaignId: ${eo.campaignId}, active: ${eo.isActive})`,
    );
  }
  console.log(`  Polls: ${wrongUserPolls.length}`);
  for (const p of wrongUserPolls) {
    console.log(`    - ${p.id} (name: ${p.name}, completed: ${p.isCompleted})`);
  }

  // --- Show what the correct user owns ---
  const correctUserCampaigns = await prisma.campaign.findMany({
    where: { userId: correctUser.id },
    select: { id: true, slug: true, createdAt: true },
  });
  const correctUserElectedOffices = await prisma.electedOffice.findMany({
    where: { userId: correctUser.id },
    select: { id: true, campaignId: true, isActive: true },
  });

  console.log("\n--- Correct user's data ---");
  console.log(`  Campaigns: ${correctUserCampaigns.length}`);
  for (const c of correctUserCampaigns) {
    console.log(
      `    - ${c.id} (slug: ${c.slug}, created: ${c.createdAt.toISOString()})`,
    );
  }
  console.log(`  Elected offices: ${correctUserElectedOffices.length}`);
  for (const eo of correctUserElectedOffices) {
    console.log(
      `    - ${eo.id} (campaignId: ${eo.campaignId}, active: ${eo.isActive})`,
    );
  }

  // --- Determine actions ---
  console.log("\n========================================");
  console.log("PLANNED ACTIONS:");
  console.log("========================================");

  let step = 1;
  if (correctUserCampaigns.length > 0) {
    console.log(
      `${step}. Delete accidental campaign(s) from correct user (${correctUser.id}):`,
    );
    for (const c of correctUserCampaigns) {
      console.log(`   - Campaign ${c.id} (slug: ${c.slug})`);
    }
    console.log(
      `   (Cascading deletes: PathToVictory, TopIssues, AiChats, Website, etc.)`,
    );
    step++;
  }

  console.log(
    `${step}. Transfer campaign(s) from wrong user (${wrongUser.id}) to correct user (${correctUser.id})`,
  );
  for (const c of wrongUserCampaigns) {
    console.log(`   - Campaign ${c.id} (slug: ${c.slug})`);
  }
  step++;

  console.log(
    `${step}. Transfer elected offices & polls from wrong user to correct user`,
  );
  console.log(
    `   - ${wrongUserElectedOffices.length} elected office(s) will have userId updated`,
  );
  console.log(
    `   - ${wrongUserPolls.length} poll(s) will follow via their elected office`,
  );
  step++;

  console.log(`${step}. Delete the wrong-email user (${wrongUser.id})`);
  console.log("========================================\n");

  const proceed = await confirm({
    message: "Proceed with these changes?",
    default: false,
  });

  if (!proceed) {
    console.log("Aborted.");
    return;
  }

  // --- Execute in a transaction ---
  await prisma.$transaction(async (tx) => {
    // 1. Delete accidental campaigns from correct user FIRST
    //    Must delete elected offices referencing them first (onDelete: NoAction)
    for (const c of correctUserCampaigns) {
      const linkedOffices = await tx.electedOffice.findMany({
        where: { campaignId: c.id },
      });
      for (const eo of linkedOffices) {
        // These shouldn't have polls, but check to be safe
        const pollCount = await tx.poll.count({
          where: { electedOfficeId: eo.id },
        });
        if (pollCount > 0) {
          throw new Error(
            `Elected office ${eo.id} on accidental campaign ${c.id} has ${pollCount} polls — aborting to avoid data loss`,
          );
        }
        await tx.electedOffice.delete({ where: { id: eo.id } });
        console.log(
          `Deleted elected office ${eo.id} from accidental campaign ${c.id}`,
        );
      }
      await tx.campaign.delete({ where: { id: c.id } });
      console.log(`Deleted accidental campaign ${c.id} (slug: ${c.slug})`);
    }

    // 2. Transfer wrong user's campaign to correct user
    for (const c of wrongUserCampaigns) {
      await tx.campaign.update({
        where: { id: c.id },
        data: { userId: correctUser.id },
      });
      console.log(
        `Transferred campaign ${c.id} (slug: ${c.slug}) to user ${correctUser.id}`,
      );
    }

    // 3. Transfer elected offices to correct user
    for (const eo of wrongUserElectedOffices) {
      await tx.electedOffice.update({
        where: { id: eo.id },
        data: { userId: correctUser.id },
      });
      console.log(
        `Transferred elected office ${eo.id} to user ${correctUser.id}`,
      );
    }

    // 4. Delete the wrong-email user
    await tx.user.delete({ where: { id: wrongUser.id } });
    console.log(
      `Deleted wrong-email user ${wrongUser.id} (${wrongUser.email})`,
    );
  });

  console.log(
    "\nDone! The correct user now owns the campaign, elected office, and polls.",
  );
  console.log(
    `User ${correctUser.id} (${correctUser.email}) should now see their poll.`,
  );
};
