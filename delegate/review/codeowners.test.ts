/**
 * The repo's own `.github/CODEOWNERS`, tested against the resolver the gate
 * actually uses.
 *
 * Every other test of `gating.ts` uses a fixture document, which means nothing
 * pinned the shipped file: a reordering that moved the carve-out above
 * `/deploy/` would silently resolve the reviewer's own logic to unowned, and
 * the bot could approve a change to itself. That is the invariant this test
 * exists for, and it is why it reads the real file rather than a copy.
 *
 * The order matters because `resolveOwnership` walks the patterns from the end
 * and the first match wins, which is `CODEOWNERS`'s own last-match rule. A
 * block placed before `/deploy/` is not an error and not a warning; it is
 * simply overridden, which is the failure this pins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodeowners, resolveOwnership, hasStarDefault } from "./gating.ts";

const repoRoot = join(__dirname, "..", "..");
const codeowners = readFileSync(join(repoRoot, ".github", "CODEOWNERS"), "utf-8");
const patterns = parseCodeowners(codeowners);

const ownership = (path: string) => resolveOwnership(patterns, path);

test("the shipped CODEOWNERS still has a `*` default with owners", () => {
  // Without it every path is `unmatched`, the gate cannot derive authority,
  // and every PR is flagged rather than approved.
  assert.equal(hasStarDefault(patterns), true);
});

test("each de-owned tree resolves to unowned", () => {
  for (const path of [
    "deploy-workbench/index.ts",
    "deploy-workbench/bifrost/vk-reader.ts",
    "deploy-org/index.ts",
    "deploy-org/policies.ts",
    "deploy-infrastructure/index.ts",
    "deploy-infrastructure/sheriff-lambda.ts",
  ]) {
    assert.equal(ownership(path), "unowned", path);
  }
});

test("the carve-out resolves to owned, so the bot cannot approve its own logic", () => {
  // The image binding, the gating mode, the record bucket, the secret key
  // list, the dispatcher's authority and the delegate-path IAM. If the block
  // at the bottom of the file is moved above `/deploy/` this test fails,
  // which is the point: the override is order-dependent and silent.
  for (const path of [
    "deploy/components/worker.ts",
    "deploy/components/webhooks.ts",
    "deploy/index.ts",
    "deploy/deploy.sh",
    "deploy/delegate-secret.ts",
    "deploy/components/ci-roles.ts",
    "deploy/components/ci-roles/policies.ts",
  ]) {
    assert.equal(ownership(path), "owned", path);
  }
});

test("deploy/ is de-owned outside the carve-out, on purpose", () => {
  // The engineer's line: bot approval of delegate *infrastructure* is
  // accepted, and only delegate logic and authority are carved out. If one of
  // these resolves to owned, the carve-out has widened past the decision.
  for (const path of [
    "deploy/Pulumi.yaml",
    "deploy/check-secret-keys.ts",
    "deploy/components/identity-center.ts",
    "deploy/components/identity-center/policies.ts",
    "deploy/components/bifrost-vk-reader.ts",
    "deploy/components/delegate-swarm-prod-read.ts",
  ]) {
    assert.equal(ownership(path), "unowned", path);
  }
});

test("paths outside the de-owned trees stay owned", () => {
  for (const path of [
    ".github/CODEOWNERS",
    ".github/workflows/deploy.yml",
    "docs/plan-gated-merges.md",
    "CLAUDE.md",
    "delegate/review/gates.ts",
    "utils/accounts.ts",
    "scripts/enable-bedrock-models.ts",
    "package.json",
    "deploy-foo/index.ts",
  ]) {
    assert.equal(ownership(path), "owned", path);
  }
});

test("the carve-out is narrower than `deploy/components/`", () => {
  // `/deploy/components/` would also own the identity center and the bifrost
  // readers, which is wider than the decision. This pins the two explicit
  // ci-roles files rather than the directory form.
  assert.equal(ownership("deploy/components/sheriff-grant.ts"), "unowned");
  assert.equal(ownership("deploy/components/ci-roles/other.ts"), "unowned");
  assert.equal(ownership("deploy/components/ci-roles/policies.ts"), "owned");
});
