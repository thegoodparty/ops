import * as fs from "fs";
import * as path from "path";
import * as esbuild from "esbuild";

const JOBS_DIR = path.join(__dirname, "jobs");
const OUT_DIR = path.join(__dirname, "dist", "jobs");

const SKIP = new Set(["framework.ts", "example-job.ts"]);

type ManifestEntry =
  | { type: "job"; schedule: string }
  | { type: "agent"; schedule: string };

const bundleRegularJob = async (name: string) => {
  const entrypoint = [
    `import job from "./${name}.js";`,
    `import { createHandler } from "./framework.js";`,
    `export const handler = createHandler(job);`,
  ].join("\n");

  await esbuild.build({
    stdin: { contents: entrypoint, resolveDir: JOBS_DIR, loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node22",
    outfile: path.join(OUT_DIR, name, "handler.js"),
  });
};

const bundleAgentJobDispatcher = async (name: string) => {
  const entrypoint = `
    import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
    const ecs = new ECSClient({});
    export const handler = async () => {
      const { CLUSTER_ARN, TASK_DEF_ARN, SUBNET_IDS, SECURITY_GROUP_ID } = process.env;
      if (!CLUSTER_ARN || !TASK_DEF_ARN || !SUBNET_IDS || !SECURITY_GROUP_ID)
        throw new Error("Missing ECS env vars");
      await ecs.send(new RunTaskCommand({
        cluster: CLUSTER_ARN,
        taskDefinition: TASK_DEF_ARN,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: SUBNET_IDS.split(","),
            securityGroups: [SECURITY_GROUP_ID],
            assignPublicIp: "ENABLED",
          },
        },
        overrides: {
          containerOverrides: [{
            name: "agent",
            environment: [{ name: "AGENT_JOB", value: JSON.stringify({ jobName: "${name}" }) }],
          }],
        },
        tags: [{ key: "job", value: "${name}" }],
      }));
      console.log("Dispatched agent job: ${name}");
    };
  `;

  await esbuild.build({
    stdin: { contents: entrypoint, resolveDir: JOBS_DIR, loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node22",
    outfile: path.join(OUT_DIR, name, "handler.js"),
  });
};

const run = async () => {
  const files = fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".ts") && !SKIP.has(f));

  if (files.length === 0) {
    console.log("No jobs found, skipping.");
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifest: Record<string, ManifestEntry> = {};

  for (const file of files) {
    const name = file.replace(".ts", "");
    const imported = await import(path.join(JOBS_DIR, file));
    const jobType = imported.default.type ?? "job";

    if (jobType === "agent") {
      console.log(`Bundling agent job dispatcher: ${name}`);
      await bundleAgentJobDispatcher(name);
      manifest[name] = {
        type: "agent",
        schedule: imported.default.definition.schedule,
      };
    } else {
      console.log(`Bundling job: ${name}`);
      await bundleRegularJob(name);
      manifest[name] = {
        type: "job",
        schedule: imported.default.definition.schedule,
      };
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`Manifest written with ${Object.keys(manifest).length} job(s).`);
};

run().catch((err) => {
  console.error("Failed to generate lambdas:", err);
  process.exit(1);
});
