import { spawnSync } from "node:child_process";

/**
 * The small AWS CLI shim both deploy checks share.
 *
 * The checks run inside the workflow, where the AWS CLI is already installed
 * and the job's environment already holds a first-hop session. They need a
 * second hop into the workbench account (`pulumi-deploy`), because the
 * first-hop role only carries the Pulumi backend grant and the SSM parameter
 * the deploy reads; it does not read Secrets Manager or ECS in 024901689212.
 *
 * Assuming the role here, rather than adding another
 * `configure-aws-credentials` step, keeps the job's environment on the
 * first-hop session. `Enable Bedrock models` runs after the post-apply check
 * and makes its own hop with exactly those credentials; replacing the session
 * would break it. The temporary credentials this returns are used only for the
 * child `aws` processes and are never printed.
 */

export type AwsEnvironment = NodeJS.ProcessEnv;

const run = (args: string[], env: AwsEnvironment): string => {
  const result = spawnSync("aws", args, {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`could not run aws ${args[0]}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(
      `aws ${args[0]} failed (exit ${result.status})${
        stderr ? `: ${stderr}` : ""
      }`,
    );
  }

  // Only stdout is returned, and callers must never print it unless they have
  // established that it contains no secret value. The secret check parses the
  // SecretString as JSON and only ever reports key names.
  return (result.stdout ?? "").trim();
};

export const runAws = (args: string[], env: AwsEnvironment = process.env): string =>
  run(args, env);

/**
 * Assume `roleArn` from the current environment and return an environment for
 * child `aws` commands that use the resulting temporary credentials.
 */
export const assumeRoleEnvironment = (
  roleArn: string,
  sessionName: string,
  env: AwsEnvironment = process.env,
): AwsEnvironment => {
  const raw = run(
    [
      "sts",
      "assume-role",
      "--role-arn",
      roleArn,
      "--role-session-name",
      sessionName,
      "--output",
      "json",
    ],
    env,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `aws sts assume-role returned output this script could not parse for ${roleArn}`,
    );
  }

  const credentials =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { Credentials?: Record<string, string> }).Credentials
      : undefined;

  if (
    !credentials?.AccessKeyId ||
    !credentials?.SecretAccessKey ||
    !credentials?.SessionToken
  ) {
    throw new Error(
      `aws sts assume-role for ${roleArn} returned no temporary credentials`,
    );
  }

  const assumed: AwsEnvironment = {
    ...env,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
  };

  // A profile in the inherited environment would be a second, weaker source of
  // credentials and makes the hop confusing to debug. The explicit environment
  // credentials above are what the child process should use.
  delete assumed.AWS_PROFILE;
  delete assumed.AWS_DEFAULT_PROFILE;

  return assumed;
};
