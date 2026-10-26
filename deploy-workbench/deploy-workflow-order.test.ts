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
 * The rule these tests pin: **everything the task definition can resolve is
 * pushed, and the run has stopped if any of it could not be, before an apply
 * that can drain the running task.** The workflow is read as text rather than
 * parsed: the repo has no YAML dependency, and every value checked here is a
 * step name or a one-line scalar.
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

/** Step names in file order. Steps without a `name:` are not steps here. */
const stepNames = (): string[] =>
  [...SOURCE.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1].trim());

const stepIndex = (name: string): number => {
  const index = stepNames().indexOf(name);
  assert.notEqual(index, -1, `deploy-workbench.yml has no step named "${name}"`);
  return index;
};

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

  it("skips a push whose repository the first apply has not created yet", () => {
    // Not every run has repositories to push to: Pulumi creates them, so on a
    // brand-new stack there is no apply behind the first run. The push steps
    // therefore have to be able to decline without failing the run, because
    // failing before the apply would mean the stack never gets created at all.
    // The run warns instead, and the next run pushes.
    assert.equal(
      [...SOURCE.matchAll(/--repository-names/g)].length,
      IMAGE_STEPS.length,
      "every image step must ask whether its repository exists before pushing",
    );
    assert.match(
      SOURCE,
      /::warning::/,
      "a skipped push must be visible in the run, not silent",
    );
  });

  it("leaves Bedrock enablement after the apply", () => {
    // It mutates the account by accepting model-provider terms, so a failed
    // apply is a reason to stop rather than to carry on. Pre-existing property
    // of this workflow; pinned because the reordering above had to move steps
    // around it.
    assert.ok(stepIndex("Enable Bedrock models") > stepIndex("Deploy"));
  });

  it("applies exactly once", () => {
    // A second apply is a second drain of the running task, and the ordering
    // above only guarantees the images exist for the first.
    assert.equal(
      [...SOURCE.matchAll(/^ +run: \.\/deploy\.sh$/gm)].length,
      1,
    );
  });
});
