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
 * The AWS CLI, with the failure itself rather than a thrown error.
 *
 * `runAws` above throws on any non-zero exit, which is right for a read with a
 * single failure meaning. `GetUserId` does not have one: `ResourceNotFoundException`
 * is "no such user", which is exactly the answer the membership check wants,
 * and every other error is an outage. The mint draws that line in
 * `createMembershipDirectory` (`vk-mint-handler.ts`); this is the CLI's half of
 * it, and without it a typo in an email reads as a directory outage and the
 * check exits "could not complete" instead of naming the person.
 *
 * Only the exit status and stderr are returned. A caller that has established
 * the failure is a known one may read the text, and no stderr from either
 * command can carry a secret.
 */
export const tryRunAws = (
  args: string[],
  env: AwsEnvironment = process.env,
):
  | { ok: true; stdout: string }
  | { ok: false; status: number | null; stderr: string } => {
  const result = spawnSync("aws", args, {
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, status: null, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stderr: (result.stderr ?? "").trim(),
    };
  }
  return { ok: true, stdout: (result.stdout ?? "").trim() };
};

/**
 * Whether an `identitystore` failure is "no such user" rather than an outage.
 *
 * The CLI prints `ResourceNotFoundException` in the message for a `GetUserId`
 * on an address that names no user, and the SDK surfaces the same code as an
 * exception class. Both callers of this map to "not a member", which is the
 * answer that fails closed on membership while still naming the person.
 */
export const isNoSuchUser = (stderr: string): boolean =>
  /ResourceNotFoundException/.test(stderr);

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
