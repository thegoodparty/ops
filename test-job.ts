import { readdirSync } from "fs";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const jobArg = process.argv[2];
if (!jobArg) {
  const jobs = readdirSync(`${__dirname}/jobs`)
    .filter((f) => f.endsWith(".ts") && f !== "framework.ts")
    .map((f) => f.replace(".ts", ""));
  console.error("Usage: npx tsx test-job.ts <job-name>");
  console.error("Available jobs:", jobs.join(", "));
  process.exit(1);
}

const job = jobArg.replace(".ts", "");
const jobFiles = readdirSync(`${__dirname}/jobs`).map(
  (filename) => `${__dirname}/jobs/${filename}`
);
const matches = jobFiles.filter((filepath) => filepath.endsWith(`/${job}.ts`));

if (matches.length === 0) {
  console.error(`No job found for "${job}"`);
  process.exit(1);
}

const run = async () => {
  process.env.SECRET_ARN =
    "arn:aws:secretsmanager:us-west-2:333022194791:secret:DELEGATES-l2pL7J";

  const { createHandler } = await import("./jobs/framework");
  const mod = await import(matches[0]);
  const handler = createHandler(mod.default);

  console.log(`Running job: ${job}`);
  await handler();
};

void run();
