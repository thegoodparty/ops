import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The order of `deploy-workbench.yml`'s steps, which is load-bearing and was
 * not, once.
 *
 * The service runs one Fargate task with `minimumHealthyPercent: 0` (see
 * `DEPLOYMENT_MINIMUM_HEALTHY_PERCENT` in `ecs.ts`): a new deployment drains
 * the old task before it starts the replacement, because OSS Bifrost is
 * single-node. So the moment the apply updates the service, the only healthy
 * task is gone. If the task definition it rolled out names an image that CI has
 * not pushed yet, nothing can replace it and the ALB has no healthy target to
 * send to: 503 at the edge, indefinitely, from a green apply.
 *
 * That is what the workflow used to do. It applied first and built the derived
 * images after, so a merge that changed the bootstrap script rolled out
 * `bifrost-bootstrap:v2.3.0-dc6dd0e438a6` before anything pushed that tag, and
 * the run then died in the build (`chmod: /bifrost-bootstrap/bootstrap.sh:
 * Operation not permitted`, deploy run 40329170411). `bifrost.workbench.
 * goodparty.org` served 503 from 13:23 UTC on 2026-10-26 until someone rolled
 * the service by hand.
 *
 * The rule these tests pin: **every image the task definition can resolve is in
 * ECR before an apply that can drain the running task, and the run has stopped
 * if any of them could not be pushed.** No step may decide to skip a push and
 * carry on: a skipped push is an apply onto an image that does not exist, which
 * is the outage. The one thing that cannot be pushed before an apply is a
 * repository the apply has never created, so the run creates those first with a
 * targeted apply that touches nothing else -- and if the probe cannot tell
 * whether a repository exists, it stops.
 *
 * The workflow is read as text rather than parsed: the repo has no YAML
 * dependency, and the assertions here are about the order and the shape of the
 * steps, both of which are a `- name:` line and the block under it.
 */
const WORKFLOW = path.resolve(
  __dirname,
  "../.github/workflows/deploy-workbench.yml",
);
const SOURCE = fs.readFileSync(WORKFLOW, "utf8");
/** The management account's role, the first hop every apply starts from. */
const FIRST_HOP_ROLE_ARN =
  "arn:aws:iam::333022194791:role/github-actions-workbench-deploy";

/** The three images the task definition resolves, and their push steps. */
const IMAGE_STEPS = [
  "Mirror the pinned Bifrost image",
  "Build and push the derived oauth2-proxy image",
  "Build and push the derived bootstrap image",
];

type Step = { name: string; body: string };

/**
 * A block with its comment lines removed. Every assertion below is about what
 * the workflow *does*, and a comment that mentions `describe-repositories` or
 * `--target` (explaining why the step exists) is not the step doing it.
 */
const codeOnly = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const DEPLOY_SH = codeOnly(
  fs.readFileSync(path.resolve(__dirname, "deploy.sh"), "utf8"),
);

/**
 * The job's steps in file order. A step is a line starting with six spaces and
 * `- `; its body runs to the next one. Steps without a `name:` (the plain
 * `run:`/`uses:` ones) come back with an empty name, and the comment block
 * above a step belongs to the step before it, so nothing asserted below reads a
 * step's leading comment as its body.
 */
const steps = (): Step[] => {
  const starts = [...SOURCE.matchAll(/^ {6}- /gm)].map((match) => match.index);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : SOURCE.length;
    const body = codeOnly(SOURCE.slice(start, end));
    const name = body.match(/^ {6}- name: (.+)$/m)?.[1].trim() ?? "";
    return { name, body };
  });
};

const stepIndex = (name: string): number => {
  const index = steps().findIndex((step) => step.name === name);
  assert.notEqual(index, -1, `deploy-workbench.yml has no step named "${name}"`);
  return index;
};

const stepNamed = (name: string): Step => steps()[stepIndex(name)];

describe("deploy-workbench.yml step order", () => {
  it("pushes every image the task definition resolves before the apply", () => {
    // The apply is what drains the running task, so an image that reaches ECR
    // after it is an image the replacement task cannot pull.
    const deploy = stepIndex("Deploy");
    for (const step of IMAGE_STEPS) {
      assert.ok(
        stepIndex(step) < deploy,
        `"${step}" runs after the apply; a task definition naming an image pushed there cannot start`,
      );
    }
  });

  it("creates a missing repository with a targeted apply, before anything pushes", () => {
    // The only write allowed before the images exist, and it must be limited to
    // the ECR repositories: a full apply here would create the repository and
    // roll the service out onto the image in the same breath, which is the
    // outage. `--target` updates what it matches and leaves the stack alone.
    //
    // Unconditional on purpose. A conditional pass has to decide that a
    // repository is missing from a failed API call, and an expired session or a
    // throttle answers the same way a missing repository does; a check that
    // gets that wrong skips the creation and the pushes, then lets the apply
    // drain the task onto an image ECR does not have.
    const create = stepIndex(
      "Create the image repositories if the stack does not have them yet",
    );
    assert.ok(
      create < stepIndex(IMAGE_STEPS[0]),
      "the targeted apply must run before the first push, or the push has nowhere to go",
    );
    assert.ok(
      create < stepIndex("Configure AWS Credentials (workbench)"),
      "it must run before the workbench session replaces the first-hop credentials deploy.sh needs for the state passphrase",
    );

    const createBody = stepNamed(
      "Create the image repositories if the stack does not have them yet",
    ).body;
    assert.ok(
      !/\n\s+if:/.test(createBody),
      "the targeted apply must not be conditional: its point is that no check decides whether a push can happen",
    );
    assert.ok(
      createBody.includes(
        'DEPLOY_TARGET: "urn:pulumi:*::*::aws:ecr/repository:Repository::*"',
      ),
      "the create step must target the stack's ECR repositories and nothing else",
    );
    assert.ok(
      createBody.includes("run: ./deploy.sh"),
      "the create step must go through deploy.sh, which owns the login and stack select",
    );
  });

  it("cannot skip a push", () => {
    // Nothing here may decide that an image does not have to be pushed: no
    // repository probe to read a failure as an absence, and no
    // warning-and-yield path. The targeted apply above is what makes the
    // repositories exist, so every push either succeeds or stops the run before
    // the apply. The `describe-images` checks that remain are a different
    // thing: they skip a push only when the tag is already in ECR.
    const skipPaths = steps().filter(
      (step) =>
        step.body.includes("describe-repositories") ||
        step.body.includes("::warning::"),
    );
    assert.deepEqual(
      skipPaths.map((step) => step.name),
      [],
      "these steps can skip a push and carry on to the apply",
    );
  });

  it("applies as the first-hop role, not the chained workbench session", () => {
    // `aws-actions/configure-aws-credentials` exports the session it obtains
    // into the job environment, so the step a later `configure` leaves behind
    // is the one the apply runs as. The image steps need `pulumi-deploy` in
    // the workbench account (chained), and `deploy.sh` needs the management
    // account's role back: it reads the Pulumi state passphrase from SSM there
    // (`PulumiStatePassphrase` in `deploy/components/ci-roles/policies.ts`),
    // and the provider makes its own hop into 024901689212 from `index.ts`.
    const deployAt = SOURCE.indexOf("      - name: Deploy");
    assert.notEqual(deployAt, -1, 'no step named "Deploy"');
    const assumesBefore = [
      ...SOURCE.slice(0, deployAt).matchAll(/^ {10}role-to-assume: (.+)$/gm),
    ];
    assert.ok(assumesBefore.length > 0, "the apply runs with no role assumed");
    assert.equal(
      assumesBefore[assumesBefore.length - 1][1].trim(),
      FIRST_HOP_ROLE_ARN,
      "the apply inherits the workbench session the image steps left behind; it cannot read the state passphrase from there",
    );
  });

  it("applies the whole stack exactly once, and only after every push", () => {
    // A second full apply is a second drain of the running task, and the
    // ordering above only guarantees the images exist for the first. The one
    // other `deploy.sh` invocation is the targeted repositories pass.
    const running = steps().filter((step) => step.body.includes("run: ./deploy.sh"));
    assert.equal(running.length, 2, "expected one targeted and one full apply");
    const full = running.filter((step) => !step.body.includes("DEPLOY_TARGET"));
    const targeted = running.filter((step) => step.body.includes("DEPLOY_TARGET"));
    assert.equal(full.length, 1, "exactly one untargeted apply");
    assert.equal(targeted.length, 1, "exactly one targeted apply");
    assert.ok(
      stepIndex(full[0].name) > stepIndex(IMAGE_STEPS[IMAGE_STEPS.length - 1]),
      "the full apply must run after the last push",
    );
  });

  it("leaves Bedrock enablement after the apply", () => {
    // It mutates the account by accepting model-provider terms, so a failed
    // apply is a reason to stop rather than to carry on. Pre-existing property
    // of this workflow; pinned because the reordering above had to move steps
    // around it.
    assert.ok(stepIndex("Enable Bedrock models") > stepIndex("Deploy"));
  });

  it("supports the targeted apply in deploy.sh, and only on the write path", () => {
    assert.ok(
      DEPLOY_SH.includes('pulumi up --diff --yes --target "$DEPLOY_TARGET"'),
      "deploy.sh must pass the target through to pulumi up",
    );
    assert.equal(
      [...DEPLOY_SH.matchAll(/--target/g)].length,
      1,
      "one target, one flag: the glob is passed whole rather than split",
    );
    // Preview mode returns before the apply, so a preview never becomes a
    // targeted write: the target is read only by the `pulumi up` below.
    const previewAt = DEPLOY_SH.indexOf('if [ "$PREVIEW" = "true" ]');
    const targetUsage = DEPLOY_SH.indexOf("--target");
    assert.ok(previewAt !== -1 && targetUsage > previewAt, "the target is used outside the preview path");
  });

  it("targets every ECR repository this stack declares, by type", () => {
    // The glob is written by type rather than by name so that renaming a
    // repository resource does not silently stop matching it -- and this
    // checks the type it names is the one the modules declare, and that the
    // URNs those modules produce are what a `urn:pulumi:<stack>::<project>` glob
    // matches.
    const pattern = stepNamed(
      "Create the image repositories if the stack does not have them yet",
    ).body.match(/DEPLOY_TARGET: "([^"]+)"/)?.[1];
    assert.ok(pattern, "the create step has no DEPLOY_TARGET");
    const asRegExp = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^:]*")}$`,
    );

    const logicalNames = [
      "bifrost-image.ts",
      "oauth2-proxy-image.ts",
      "bootstrap-image.ts",
    ].flatMap((file) => {
      const source = fs.readFileSync(path.resolve(__dirname, file), "utf8");
      return [...source.matchAll(/new aws\.ecr\.Repository\(\s*"([^"]+)"/g)].map(
        (match) => match[1],
      );
    });
    assert.equal(logicalNames.length, 3, `expected three ECR repositories: ${logicalNames}`);
    for (const name of logicalNames) {
      assert.match(
        `urn:pulumi:main::workbench::aws:ecr/repository:Repository::${name}`,
        asRegExp,
        `the target glob does not match the ${name} repository this stack declares`,
      );
    }
  });
});

describe("deploy-workbench.yml deploy health checks", () => {
  // Two failures of the 2026-10-26 deploy, and where each check sits.
  //
  // 1. The task definition named `BIFROST_SETUP_TOKEN`, which `bifrost/gateway`
  //    did not contain. ECS found that at task launch, after the apply had
  //    already drained the only healthy task. The preflight therefore runs
  //    inside deploy.sh, after the stack is selected and configured, and
  //    before the full `pulumi up`. It is unconditional on the full-apply path:
  //    there is no "could not check, carry on" branch.
  //
  // 2. The run reported success while the service was empty. The post-apply
  //    step waits for a real steady state and prints the service's events on
  //    failure. It runs after the apply and before Bedrock enablement, so a
  //    broken service stops the workflow before it mutates anything else.
  it("checks every referenced secret before the full apply, from the synthesized task definition", () => {
    const preflightAt = DEPLOY_SH.indexOf("scripts/preflight-secrets.ts");
    assert.notEqual(
      preflightAt,
      -1,
      "deploy.sh must run the pre-apply secret check",
    );

    const targetedAt = DEPLOY_SH.indexOf("--target");
    const fullApplyAt = DEPLOY_SH.lastIndexOf("pulumi up --diff --yes");
    assert.notEqual(targetedAt, -1, "the targeted repositories apply is gone");
    assert.notEqual(fullApplyAt, -1, "the full apply is gone");
    assert.ok(
      preflightAt > targetedAt,
      "the secret check belongs on the full-apply path, not the repositories pass",
    );
    assert.ok(
      preflightAt < fullApplyAt,
      "the secret check must run before the apply that drains the task",
    );

    assert.ok(
      DEPLOY_SH.includes("pulumi preview --json"),
      "the required keys must come from the synthesized task definition, not a hand-maintained list",
    );
    assert.ok(
      DEPLOY_SH.includes("pulumi stack export"),
      "an unchanged task definition can be absent from preview steps; the exported state is the fallback",
    );

    const invocationLine = DEPLOY_SH
      .split("\n")
      .find((line) => line.includes("scripts/preflight-secrets.ts"));
    assert.ok(invocationLine, "no preflight invocation line");
    assert.ok(
      !invocationLine.includes("|| true"),
      "a secret check that cannot run must fail the deploy, never pass silently",
    );
  });

  it("waits for the service to come back up after the apply, before Bedrock", () => {
    const verifyAt = stepIndex("Verify the service returned to a steady state");
    assert.ok(
      verifyAt > stepIndex("Deploy"),
      "the health check must run after the apply that can drain the task",
    );
    assert.ok(
      verifyAt < stepIndex("Enable Bedrock models"),
      "a failed service must stop the run before it mutates the account further",
    );

    const body = stepNamed("Verify the service returned to a steady state").body;
    assert.ok(
      body.includes("scripts/verify-service.ts"),
      "the check must run the service verifier",
    );
    assert.ok(
      /--timeout-seconds\s+\d+/.test(body),
      "the wait must be bounded by an explicit timeout",
    );
    assert.ok(
      !body.includes("::warning::"),
      "the post-apply check must fail the run, not warn",
    );
    assert.ok(
      !body.includes("continue-on-error"),
      "the post-apply check must fail the run, not continue",
    );
    assert.ok(
      !body.includes("configure-aws-credentials"),
      "the check must not replace the job's first-hop session; Bedrock enablement below needs it back",
    );
  });
});
