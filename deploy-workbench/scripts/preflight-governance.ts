import { readFileSync } from "node:fs";
import * as path from "node:path";

import { IDENTITY_STORE_ID, MANAGEMENT_ACCOUNT_ID } from "../../utils/accounts";
import { VK_READER_SESSION_NAME } from "../../deploy/components/bifrost-vk-reader";
import {
  checkGovernanceOverrides,
  formatGovernanceProblems,
  type GovernanceProblem,
} from "../bifrost/governance-desired-state";
import { ENGINEERS_GROUP_ID } from "../bifrost/vk-mint-core";
import { assumeRoleEnvironment, runAws } from "./aws-role";

/**
 * The apply-time half of step 2's validation: is every email in the overrides
 * document in the `Engineers` group, right now?
 *
 * `validateGovernanceOverrides` checks the document's shape, its durations and
 * its field names, and `governance-parameters.ts` runs that half in the Pulumi
 * program, so a malformed document fails a preview. The one check it cannot
 * make is membership, because that is a directory read and the Pulumi program
 * runs as the admin deploy role (`pulumicons`'s whole design is that it is not
 * the reader).
 *
 * So this script makes the read the way the two Lambdas do, through
 * `bifrost-vk-reader` in the management account, and applies the same
 * validation with the member set it read. It runs in the deploy workflow before
 * the apply, on the first-hop credentials, which is the last moment before the
 * parameter is written with the email's override in it.
 *
 * Why not in `npm test`: `deploy.yml` runs the suite in a job with no AWS
 * credentials and no OIDC token, deliberately, because the tests execute
 * repository code. A directory read there would have to be given credentials,
 * and that job is the one place that must not have any. The shape half is in
 * the suite, over the committed file; only the membership half needs the
 * directory.
 *
 * Failure is a non-zero exit, always. A refused `GetUserId` is not a missing
 * member: it is "I could not tell", and treating that as a pass would write an
 * override nobody could hold. The `Engineers` group is checked from its own
 * membership list, the way the janitor's empty-group guard does, so a member
 * read that comes back empty admits nobody.
 *
 * Nothing here prints an email's directory id or a credential. It prints the
 * emails that are not members and the paths of the malformed fields, which is
 * what the person who wrote the document needs.
 */

/** The document, relative to the repo root. Named in every failure message. */
export const GOVERNANCE_OVERRIDES_FILE =
  "deploy-workbench/bifrost/governance-overrides.json";

/**
 * The `Engineers` group, imported rather than retyped: `vk-mint-core.ts` holds
 * the literal both Lambdas use, `deploy/components/bifrost-vk-reader.ts` holds
 * the ARN, and `deploy/bifrost-vk-reader.test.ts` reads that file so the three
 * cannot drift. This script is a fourth reader of the same group and uses the
 * same constant rather than a fourth literal.
 */
export { ENGINEERS_GROUP_ID };

/** The role assumed for the read, the same one both Lambdas assume. */
export const VK_READER_ROLE_ARN = `arn:aws:iam::${MANAGEMENT_ACCOUNT_ID}:role/bifrost-vk-reader`;

/**
 * The path the document is read from, resolved from this file rather than from
 * the working directory: `deploy.sh` runs the script from `deploy-workbench/`,
 * and a relative path there would read a different file than the one the apply
 * publishes.
 */
export const overridesPath = (): string =>
  path.resolve(__dirname, "../../", GOVERNANCE_OVERRIDES_FILE);

/**
 * The check, over a member set the caller read. Separated from the directory
 * read so a test can drive it with a literal set: `npm test` has no directory
 * and no credentials, and this is the half that decides.
 */
export const overridesProblemsForMembers = (
  text: string,
  members: ReadonlySet<string>,
): GovernanceProblem[] =>
  checkGovernanceOverrides(text, {
    isMember: (email) => members.has(email.toLowerCase()),
  });

/**
 * Whether a directory result means "not a member". `GetUserId` answering with
 * no user id is the only case that does; every error is thrown so the caller
 * exits non-zero rather than reading an outage as an absence.
 */
export const resolveMembership = async (args: {
  getUserId: (email: string) => Promise<string | null>;
  listMemberUserIds: () => Promise<readonly string[]>;
  emails: readonly string[];
}): Promise<{ memberEmails: Set<string>; notMembers: string[] }> => {
  const memberIds = new Set(await args.listMemberUserIds());
  const memberEmails = new Set<string>();
  const notMembers: string[] = [];

  for (const email of args.emails) {
    const userId = await args.getUserId(email);
    if (userId && memberIds.has(userId)) memberEmails.add(email.toLowerCase());
    else notMembers.push(email);
  }

  return { memberEmails, notMembers };
};

/**
 * The two halves in one place, so the script's `main` is only I/O: shape first,
 * membership second, and both reported together so one run tells the author
 * everything that is wrong rather than one thing per run.
 *
 * A document that does not parse has no emails to resolve, so it is reported
 * and the directory is left alone: a directory outage beside a syntax error
 * would bury the one thing the author has to fix.
 */
export const checkOverridesAgainstDirectory = async (args: {
  text: string;
  directory: {
    getUserId: (email: string) => Promise<string | null>;
    listMemberUserIds: () => Promise<readonly string[]>;
  };
}): Promise<GovernanceProblem[]> => {
  const shapeProblems = checkGovernanceOverrides(args.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.text);
  } catch {
    return shapeProblems;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return shapeProblems;
  }

  const emails = Object.keys(parsed).filter((key) => !key.startsWith("$"));

  const { notMembers } = await resolveMembership({
    ...args.directory,
    emails,
  });

  return [
    ...shapeProblems,
    ...notMembers.map((email) => ({
      path: email,
      message:
        "is not in the Engineers group, so its override would apply to a key nobody can hold",
    })),
  ];
};

/** The line a failed run prints, with the file named. */
export const formatCheckFailure = (problems: readonly GovernanceProblem[]): string =>
  `${GOVERNANCE_OVERRIDES_FILE} has ${problems.length} problem${
    problems.length === 1 ? "" : "s"
  }:\n${formatGovernanceProblems(problems)}`;

/**
 * Reads the committed file and checks it against a directory the caller
 * supplies. Kept free of the SDK so `preflight-governance.test.ts` can drive
 * the whole path — file, parse, shape, membership, message — without AWS.
 */
export const checkCommittedOverrides = async (
  directory: {
    getUserId: (email: string) => Promise<string | null>;
    listMemberUserIds: () => Promise<readonly string[]>;
  },
  text: string = readFileSync(overridesPath(), "utf8"),
): Promise<{ ok: boolean; message: string }> => {
  const problems = await checkOverridesAgainstDirectory({ text, directory });
  return problems.length === 0
    ? { ok: true, message: `${GOVERNANCE_OVERRIDES_FILE} is valid` }
    : { ok: false, message: formatCheckFailure(problems) };
};

/**
 * The directory read, through the CLI and the reader role, exactly as
 * `scripts/verify-service.ts` reaches ECS and `preflight-secrets.ts` reaches
 * Secrets Manager: assume the role, run `aws` in the child environment it
 * returns, and keep the job's own session untouched.
 *
 * ## Which principal this can run as, and why it is not the deploy job
 *
 * `bifrost-vk-reader`'s trust admits exactly two principals, the two Lambdas'
 * execution roles (`deploy/components/bifrost-vk-reader.ts`, the
 * `GRANTEE_ROLE_ARNS` condition). The deploy job does not hold either of them,
 * and widening the trust to admit it would make the CI role a third holder of a
 * grant that exists to be narrow: that is an IAM change in `deploy/`, which is a
 * different, human-owned review, and it is not this step's.
 *
 * So the deploy job does not call this function. `main` below takes the
 * membership from whoever already has it — see `resolveMemberEmails` and the
 * `--members` path — and the reader-role form is the one a Lambda (or a human
 * with `breakglass` and the reader's session) uses. The shape half needs no
 * credentials at all and is the half that catches a typo in a field name, which
 * is the failure a document with no people can actually have.
 *
 * `GetUserId` returning nothing is not an error — the CLI exits 0 with no
 * `UserId` for an address that names no user. Every other non-zero exit throws,
 * which is the fail-closed direction: "I could not read the directory" must not
 * reach the check as "this person is not a member".
 */
export const createCliDirectory = (args: {
  roleArn?: string;
  identityStoreId?: string;
  groupId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): {
  getUserId: (email: string) => Promise<string | null>;
  listMemberUserIds: () => Promise<readonly string[]>;
} => {
  const env = assumeRoleEnvironment(
    args.roleArn ?? VK_READER_ROLE_ARN,
    VK_READER_SESSION_NAME,
    args.env ?? process.env,
  );
  const identityStoreId = args.identityStoreId ?? IDENTITY_STORE_ID;
  const groupId = args.groupId ?? ENGINEERS_GROUP_ID;

  return {
    getUserId: async (email) => {
      const raw = runAws(
        [
          "identitystore",
          "get-user-id",
          "--identity-store-id",
          identityStoreId,
          "--alternate-identifier",
          `UniqueAttribute={AttributePath=emails.value,AttributeValue=${email}}`,
          "--output",
          "json",
        ],
        env,
      );
      const parsed = JSON.parse(raw) as { UserId?: string };
      return parsed.UserId ?? null;
    },

    listMemberUserIds: async () => {
      const raw = runAws(
        [
          "identitystore",
          "list-group-memberships",
          "--identity-store-id",
          identityStoreId,
          "--group-id",
          groupId,
          "--query",
          "GroupMemberships[].MemberId.UserId",
          "--output",
          "json",
        ],
        env,
      );
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    },
  };
};

/**
 * The script's entry point, and the reason the deploy job can run it.
 *
 * The membership half is only checked when the caller has a way to read the
 * directory: `--members a@x,b@x` names the set explicitly (the form the deploy
 * job or a human with `breakglass` and the reader's session uses), and
 * otherwise the reader role is assumed, which only the two Lambdas may do. With
 * neither, the shape half still runs and still fails the build on a malformed
 * document, and the script says out loud that membership was not checked rather
 * than implying it was.
 *
 * The shape half is not a consolation prize, and it is worth being exact about
 * what each half catches. A document with no people in it can only be wrong in
 * its shape, and an unknown field, a malformed budget, a duplicate
 * `reset_duration` or a misplaced `inherit` are all shape. The membership half
 * exists for the day the document gains its first person, and the step that
 * adds one is what supplies the member set — which is the moment a human is
 * looking at the email anyway.
 *
 * `deploy.sh` runs this under `set -e`, so a non-zero exit stops the run before
 * the apply writes the parameter.
 */
const main = async (): Promise<void> => {
  const memberArgument = process.argv
    .slice(2)
    .flatMap((arg, index, args) =>
      arg === "--members" && args[index + 1] ? [args[index + 1]] : [],
    )[0];

  const explicitMembers = memberArgument
    ? new Set(
        memberArgument
          .split(",")
          .map((email) => email.trim().toLowerCase())
          .filter((email) => email !== ""),
      )
    : undefined;

  const text = readFileSync(overridesPath(), "utf8");

  if (explicitMembers) {
    const problems = checkGovernanceOverrides(text, {
      isMember: (email) => explicitMembers.has(email.toLowerCase()),
    });
    console.log(
      problems.length === 0
        ? `${GOVERNANCE_OVERRIDES_FILE} is valid, against the ${explicitMembers.size} member(s) named on the command line`
        : formatCheckFailure(problems),
    );
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  // No member set and no reader role on this caller: the shape half is still
  // worth failing a deploy for, and the message says exactly what was and was
  // not checked so nobody reads a green run as proof of membership.
  if (!process.env.READER_ROLE_ARN && !process.env.GOVERNANCE_CHECK_MEMBERSHIP) {
    const problems = checkGovernanceOverrides(text);
    console.log(
      problems.length === 0
        ? `${GOVERNANCE_OVERRIDES_FILE} is valid (shape only; membership in Engineers was not checked, because this caller holds no reader-role grant -- pass --members or GOVERNANCE_CHECK_MEMBERSHIP=1 to require it)`
        : formatCheckFailure(problems),
    );
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  const found = await checkOverridesAgainstDirectory({
    text,
    directory: createCliDirectory(),
  });
  console.log(
    found.length === 0
      ? `${GOVERNANCE_OVERRIDES_FILE} is valid (membership checked against the Engineers group)`
      : formatCheckFailure(found),
  );
  if (found.length > 0) process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `the governance override check could not complete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
