# Identity Center IaC and infra-tag protection: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring IAM Identity Center permission sets and assignments under Pulumi in `ops`, retag ops-deployed resources to `Environment: infra`, and stop `EngineerAccess` from mutating them.

**Architecture:** A new `deploy/components/identity-center.ts` imports 21 existing Identity Center resources into the existing `ops-dev` stack. Inline policies are stored as byte-exact JSON files so the import matches live state. The `Environment` default tag flips `dev` to `infra`, which alone removes engineer mutate access because `EngineerAccess` is allow-list-by-tag. Two follow-on policy edits close an escalation path and a tag-blind S3/SQS hole.

**Tech Stack:** Pulumi (TypeScript, `@pulumi/aws` v7), AWS IAM Identity Center, node:test, GitHub CODEOWNERS.

**Spec:** `docs/superpowers/specs/2026-08-27-ops-identity-center-iac-design.md`

## Global Constraints

- TypeScript style: no semicolons is NOT the ops convention. `ops` uses semicolons, double quotes, 2-space indent. Match surrounding files exactly.
- Arrow functions over `function` declarations.
- No comments unless they explain a non-obvious WHY. Never remove existing comments.
- Tests are `node:test` + `node:assert/strict`, run via `npm test`.
- Commit with `--no-verify`. No `Co-Authored-By`. No "Created by Claude" footers.
- Never merge a PR.
- AWS account `333022194791`, region `us-west-2`.
- SSO instance ARN: `arn:aws:sso:::instance/ssoins-790711c2cafff252`
- Identity store: `d-9267e5cf96`

## Split into two PRs, and why

Pulumi's inline `import` requires declared inputs to match live state. If the
policy edits ship in the same commit as the import, the import fails on
mismatch. So:

- **PR1 (Tasks 1-5):** delegate gating, tag flip, import. Declared policies are
  byte-identical to live.
- **PR2 (Tasks 6-7):** the three `EngineerAccess` edits, branched off PR1.

---

### Task 1: Stop delegate from approving permission changes

**Files:**
- Create: `.github/CODEOWNERS`
- Modify: `delegate/agents/pr-reviewer.ts` (self-review detection section, around line 250)
- Test: `delegate/agents/pr-reviewer.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: nothing importable. Guards a behavior.

Context: the reviewer already forces comment-only via `SELF_REVIEW` for paths
matching `^(delegate/|deploy/|\.github/workflows/delegate)`. That already covers
this work, but its rationale is "changes to the bot's own system", so narrowing
`deploy/` later would silently un-protect IAM. This adds an independent gate.

`gp-secops` holds only `pull` on the repo and GitHub ignores code owners without
write access, so CODEOWNERS must name `@thegoodparty/gp-contrib`, which has
`push`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import prReviewer from "./pr-reviewer";

describe("pr-reviewer permission gate", () => {
  it("names the permission paths it must never auto-approve", () => {
    const prompt = prReviewer.systemPrompt + JSON.stringify(prReviewer);
    assert.match(prompt, /PERMISSION_CHANGE/);
    assert.match(prompt, /identity-center/);
    assert.match(prompt, /CODEOWNERS/);
  });

  it("still carries the original self-review gate", () => {
    const prompt = prReviewer.systemPrompt + JSON.stringify(prReviewer);
    assert.match(prompt, /SELF_REVIEW/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL on `/PERMISSION_CHANGE/`. The self-review assertion passes already.

Note: `npm test` currently globs `delegate/framework/*.test.ts delegate/lambdas/*.test.ts`.
Add `delegate/agents/*.test.ts` to the `test` script in `package.json` as part of this step.

- [ ] **Step 3: Add the gate to the reviewer prompt**

In `delegate/agents/pr-reviewer.ts`, immediately after the "Print the decision
before continuing" block that ends the self-review detection section, insert:

```
   **Permission-change detection.** Independently of `SELF_REVIEW`, set
   `PERMISSION_CHANGE=true` if any path in the PR matches
   `^(deploy/components/identity-center|\.github/CODEOWNERS)`. These files
   define who can do what in AWS and who must approve changes to that. A bot
   approval on them is never acceptable, no matter how clean the diff looks.
   This gate is deliberately separate from `SELF_REVIEW` so that narrowing the
   self-review paths later cannot silently un-protect them.

   You are NEVER allowed to auto-approve a PR where `PERMISSION_CHANGE=true`.
   Like `SELF_REVIEW`, the scout and deep-reviewers still run normally and their
   findings are still posted as inline blockers; only the final verdict is
   forced to comment-only. Do not rationalize a carve-out — the gate is
   path-based, not content-based.
```

Then in step 8's auto-approve conditions, add `PERMISSION_CHANGE=false` to the
list of conditions that must ALL hold, alongside the existing `SELF_REVIEW=false`
condition.

- [ ] **Step 4: Create `.github/CODEOWNERS`**

```
# Changes to AWS permissions and to this file must be approved by a human.
# delegate[bot] is a GitHub App and cannot be a team member, so a code-owner
# requirement naming a team is structurally unsatisfiable by it.
#
# gp-contrib is used because it is the only team with write access to this
# repo; gp-secops has read only, and GitHub silently ignores code owners
# without write access.

/deploy/components/identity-center/    @thegoodparty/gp-contrib
/deploy/components/identity-center.ts  @thegoodparty/gp-contrib
/.github/CODEOWNERS                    @thegoodparty/gp-contrib
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add .github/CODEOWNERS delegate/agents/pr-reviewer.ts delegate/agents/pr-reviewer.test.ts package.json
git commit --no-verify -m "Gate permission-file changes from bot approval

The reviewer's existing self-review gate happens to cover deploy/, but its
rationale is about the bot's own system, so narrowing that path later would
silently un-protect IAM. This makes the protection explicit and adds
CODEOWNERS as a layer that does not depend on the bot following its prompt."
```

---

### Task 2: Tag dispatched Fargate tasks with the infra environment

**Files:**
- Modify: `delegate/lambdas/dispatch.ts`
- Test: `delegate/lambdas/dispatch.test.ts`

**Interfaces:**
- Consumes: `AgentJob` from `../framework/types`
- Produces: `buildTaskTags(job: AgentJob): { key: string; value: string }[]`

Context: `RunTask` tags currently carry only `Project` and `agent`, so running
tasks have no `Environment` tag. The tag array is built inline inside `dispatch`
and cannot be tested without mocking the ECS client. Extract it so it is
directly testable. This is a justified extraction despite the WET preference:
the test is the reason.

- [ ] **Step 1: Write the failing test**

Append to `delegate/lambdas/dispatch.test.ts`:

```typescript
import { buildTaskTags } from "./dispatch";

describe("buildTaskTags", () => {
  it("tags the task as infra so engineer policy cannot mutate it", () => {
    const tags = buildTaskTags({ agent: "pr-reviewer" } as never);
    assert.deepEqual(
      tags.find((t) => t.key === "Environment"),
      { key: "Environment", value: "infra" },
    );
  });

  it("keeps the Project and agent tags", () => {
    const tags = buildTaskTags({ agent: "pr-reviewer" } as never);
    assert.deepEqual(
      tags.find((t) => t.key === "Project"),
      { key: "Project", value: "ops" },
    );
    assert.deepEqual(
      tags.find((t) => t.key === "agent"),
      { key: "agent", value: "pr-reviewer" },
    );
  });

  it("sanitizes metadata values", () => {
    const tags = buildTaskTags({
      agent: "pr-reviewer",
      metadata: { author: "dependabot[bot]" },
    } as never);
    assert.deepEqual(
      tags.find((t) => t.key === "author"),
      { key: "author", value: "dependabot-bot-" },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL, `buildTaskTags` is not exported.

- [ ] **Step 3: Extract and extend the tag builder**

In `delegate/lambdas/dispatch.ts`, replace the inline `tags:` array with a call
to a new exported function defined above `dispatch`:

```typescript
export const buildTaskTags = (job: AgentJob) => [
  // Attribute the Fargate task's cost to the ops project in Cost
  // Explorer; the task def is tagged but RunTask tags aren't inherited.
  { key: "Project", value: "ops" },
  // Matches the stack's Environment default tag. Without it a running task
  // has no Environment tag, so it falls outside the infra tag protections.
  { key: "Environment", value: "infra" },
  { key: "agent", value: job.agent },
  ...(job.metadata
    ? Object.entries(job.metadata).map(([key, value]) => ({
        key,
        value: sanitizeTagValue(value),
      }))
    : []),
];
```

Then in the `RunTaskCommand` call, replace the whole `tags: [...]` block with:

```typescript
      tags: buildTaskTags(job),
```

Preserve the two existing comments by moving them into `buildTaskTags` as shown.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, including the pre-existing `sanitizeTagValue` suite.

- [ ] **Step 5: Commit**

```bash
git add delegate/lambdas/dispatch.ts delegate/lambdas/dispatch.test.ts
git commit --no-verify -m "Tag dispatched agent tasks as infra

Running tasks carried no Environment tag, which put them outside the tag
protections the rest of the stack relies on."
```

---

### Task 3: Flip the stack's Environment default tag to infra

**Files:**
- Modify: `deploy/deploy.sh`
- Modify: `deploy/Pulumi.ops-dev.yaml`

**Interfaces:**
- Consumes: nothing
- Produces: every stack resource gains `Environment: infra` instead of `dev`

Context: `deploy.sh` sets the tag on every run and overwrites what is in the
stack file, so both must change or a local `pulumi preview` will disagree with
CI. The stack is still named `ops-dev`; renaming a Pulumi stack requires a state
migration and is deliberately out of scope.

- [ ] **Step 1: Change the deploy script**

In `deploy/deploy.sh`, change:

```sh
pulumi config set --path aws:defaultTags.tags.Environment dev
```

to:

```sh
pulumi config set --path aws:defaultTags.tags.Environment infra
```

- [ ] **Step 2: Change the stack config**

In `deploy/Pulumi.ops-dev.yaml`, under `aws:defaultTags.tags`, change
`Environment: dev` to `Environment: infra`.

- [ ] **Step 3: Verify the two agree**

Run: `grep -n "Environment" deploy/deploy.sh deploy/Pulumi.ops-dev.yaml`
Expected: both show `infra`, no remaining `dev`.

- [ ] **Step 4: Commit**

```bash
git add deploy/deploy.sh deploy/Pulumi.ops-dev.yaml
git commit --no-verify -m "Tag ops-deployed resources as infra, not dev

EngineerAccess grants blanket mutate on anything tagged Environment=dev, so
ops infrastructure was editable by every engineer. The tag change is itself
the restriction."
```

---

### Task 4: Import Identity Center into the stack

**Files:**
- Create: `deploy/components/identity-center.ts`
- Already staged (do not regenerate): `deploy/components/identity-center/policies/engineer-access.json`, `read-only-access.json`, `product-manager.json`
- Create: `deploy/components/identity-center/policies.test.ts`
- Modify: `deploy/index.ts`
- Modify: `package.json` (test glob, if not already widened in Task 1)

**Interfaces:**
- Consumes: nothing
- Produces: `createIdentityCenter(): { permissionSets: Record<string, aws.ssoadmin.PermissionSet> }`

Context: the three JSON policy files are byte-exact captures of live state and
MUST NOT be reformatted, reindented, or have trailing newlines added or removed.
`engineer-access.json` ends with a newline; the other two do not. Pulumi's inline
`import` compares declared inputs to live state, and any whitespace change fails
the import.

Expected sha256:
- `engineer-access.json`: `8eb20244b8b3848bc44a6869ae5cb2c9be649eeb26e79d425eb82b235cd02b6c`
- `product-manager.json`: `e131860e532768dabf16fb518da04e5948723bbe1a7276d9e650996f14059eaf`
- `read-only-access.json`: `98e54d03d87835021f6fb3819f0cedc391a7bd23633d2a43aa27ab86f7b9127b`

- [ ] **Step 1: Write the failing checksum test**

Create `deploy/components/identity-center/policies.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED: Record<string, string> = {
  "engineer-access.json":
    "8eb20244b8b3848bc44a6869ae5cb2c9be649eeb26e79d425eb82b235cd02b6c",
  "product-manager.json":
    "e131860e532768dabf16fb518da04e5948723bbe1a7276d9e650996f14059eaf",
  "read-only-access.json":
    "98e54d03d87835021f6fb3819f0cedc391a7bd23633d2a43aa27ab86f7b9127b",
};

describe("inline policy fixtures", () => {
  for (const [file, sha] of Object.entries(EXPECTED)) {
    it(`${file} still matches live Identity Center byte for byte`, () => {
      const body = readFileSync(join(__dirname, "policies", file));
      assert.equal(createHash("sha256").update(body).digest("hex"), sha);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `npm test 2>&1 | tail -20`
Expected: PASS. The files are already staged. This test exists to fail loudly if
someone reformats them, which would break the import. If it FAILS now, the files
were altered — restore them before continuing.

Add `deploy/components/identity-center/*.test.ts` to the `test` script glob.

- [ ] **Step 3: Write the component**

Create `deploy/components/identity-center.ts`:

```typescript
import * as aws from "@pulumi/aws";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-790711c2cafff252";
const ACCOUNT_ID = "333022194791";
const PS_PREFIX = "arn:aws:sso:::permissionSet/ssoins-790711c2cafff252";

const psArn = (id: string) => `${PS_PREFIX}/${id}`;

// Identity store groups. The store is native (no external IdP issuer on any
// user), so these ids are stable and safe to pin.
const GROUPS = {
  engineers: "383193a0-7001-70d9-a321-ffe6d8af7378",
  admins: "88c1b330-a001-707a-06ca-94e289013bf5",
  research: "a8011350-50b1-701c-5b41-c0e4c9b30976",
  product: "2841e390-5011-7007-ad5d-c906acf4807d",
  billingAdmins: "88313300-9031-70ed-ec00-bb80ba0e94e1",
};

const SETS = {
  engineer: { id: "ps-209e00e1c6a78a7b", name: "EngineerAccess", duration: "PT12H" },
  administrator: { id: "ps-ab3b34dd2d6db1b8", name: "AdministratorAccess", duration: "PT8H" },
  readOnly: { id: "ps-790741c400f38152", name: "ReadOnlyAccess", duration: "PT8H" },
  productManager: { id: "ps-f75e5d9826239194", name: "ProductManager", duration: "PT8H" },
  billing: { id: "ps-7907e6ad83ceef38", name: "Billing", duration: "PT8H" },
};

// Byte-exact captures of the live inline policies. Reformatting these breaks
// the import: Pulumi compares declared inputs against live state verbatim.
const policy = (file: string) =>
  readFileSync(join(__dirname, "identity-center", "policies", file), "utf8");

export const createIdentityCenter = () => {
  const permissionSets = Object.fromEntries(
    Object.entries(SETS).map(([key, set]) => [
      key,
      new aws.ssoadmin.PermissionSet(
        `permissionSet-${key}`,
        {
          name: set.name,
          instanceArn: INSTANCE_ARN,
          sessionDuration: set.duration,
        },
        {
          import: `${psArn(set.id)},${INSTANCE_ARN}`,
          protect: true,
        },
      ),
    ]),
  );

  const managed: [string, string, string][] = [
    ["engineer-s3", "engineer", "arn:aws:iam::aws:policy/AmazonS3FullAccess"],
    ["engineer-readonly", "engineer", "arn:aws:iam::aws:policy/ReadOnlyAccess"],
    ["administrator", "administrator", "arn:aws:iam::aws:policy/AdministratorAccess"],
    ["readonly-secrets", "readOnly", "arn:aws:iam::aws:policy/AWSSecretsManagerClientReadOnlyAccess"],
    ["readonly-readonly", "readOnly", "arn:aws:iam::aws:policy/ReadOnlyAccess"],
    // Billing is a job-function policy, not a top-level one.
    ["billing", "billing", "arn:aws:iam::aws:policy/job-function/Billing"],
  ];

  for (const [label, setKey, managedPolicyArn] of managed) {
    const arn = psArn(SETS[setKey as keyof typeof SETS].id);
    new aws.ssoadmin.ManagedPolicyAttachment(
      `managedPolicy-${label}`,
      { instanceArn: INSTANCE_ARN, managedPolicyArn, permissionSetArn: arn },
      { import: `${managedPolicyArn},${arn},${INSTANCE_ARN}` },
    );
  }

  const inline: [string, string][] = [
    ["engineer", "engineer-access.json"],
    ["readOnly", "read-only-access.json"],
    ["productManager", "product-manager.json"],
  ];

  for (const [setKey, file] of inline) {
    const arn = psArn(SETS[setKey as keyof typeof SETS].id);
    new aws.ssoadmin.PermissionSetInlinePolicy(
      `inlinePolicy-${setKey}`,
      { instanceArn: INSTANCE_ARN, permissionSetArn: arn, inlinePolicy: policy(file) },
      { import: `${arn},${INSTANCE_ARN}` },
    );
  }

  const assignments: [string, keyof typeof GROUPS, keyof typeof SETS][] = [
    ["engineers-engineer", "engineers", "engineer"],
    ["engineers-readonly", "engineers", "readOnly"],
    ["admins-administrator", "admins", "administrator"],
    ["admins-readonly", "admins", "readOnly"],
    ["research-readonly", "research", "readOnly"],
    ["product-productManager", "product", "productManager"],
    ["billingAdmins-billing", "billingAdmins", "billing"],
  ];

  for (const [label, groupKey, setKey] of assignments) {
    const principalId = GROUPS[groupKey];
    const arn = psArn(SETS[setKey].id);
    new aws.ssoadmin.AccountAssignment(
      `assignment-${label}`,
      {
        instanceArn: INSTANCE_ARN,
        permissionSetArn: arn,
        principalId,
        principalType: "GROUP",
        targetId: ACCOUNT_ID,
        targetType: "AWS_ACCOUNT",
      },
      {
        import: `${principalId},GROUP,${ACCOUNT_ID},AWS_ACCOUNT,${arn},${INSTANCE_ARN}`,
      },
    );
  }

  return { permissionSets };
};
```

Note on `__dirname`: `ops` is `"type": "commonjs"`, so `__dirname` is available
in both the component and the test, and `import.meta` is NOT. If a
`__dirname is not defined` error appears, the file is being treated as ESM;
switch to `import.meta.dirname` in BOTH files and say so in the report.

Note on the reviewer import in Task 1: `pr-reviewer.ts` uses
`export default defineAgent({...})`, and `defineAgent` returns the config
object, so the test imports the default binding. There is no named
`prReviewer` export.

- [ ] **Step 4: Wire it into the stack**

In `deploy/index.ts`, add the import at the top with the other component imports:

```typescript
import { createIdentityCenter } from "./components/identity-center";
```

and inside the exported async function, after `createPlaywrightReportsBucket()`:

```typescript
  createIdentityCenter();
```

Do not add it to the returned outputs object. The permission set ARNs are
already pinned as constants; exporting them adds noise without adding value.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. `deploy/**/*.ts` is in the tsconfig include list, so a
mistake here fails CI.

- [ ] **Step 6: Commit**

```bash
git add deploy/components/identity-center.ts deploy/components/identity-center/ deploy/index.ts package.json
git commit --no-verify -m "Bring Identity Center permission sets under Pulumi

Permission sets and assignments were click-ops, so the policies governing
every engineer's access drifted with no review and no history. Inline
policies are stored as byte-exact captures because the import compares
declared inputs against live state verbatim."
```

---

### Task 5: Verify the import against live AWS before opening PR1

**Files:** none modified. This is a verification gate.

Context: this is the step that catches a bad import before it can delete a
permission set and revoke a group's access. Do not skip it. It is read-only.

- [ ] **Step 1: Install and build**

```bash
npm ci
npm run build
```

- [ ] **Step 2: Log in to the Pulumi backend**

```bash
export PULUMI_CONFIG_PASSPHRASE=$(aws ssm get-parameter \
  --name pulumi-state-config-passphrase --with-decryption \
  --region us-west-2 --query Parameter.Value --output text)
pulumi login s3://goodparty-iac-state
```

- [ ] **Step 3: Preview**

```bash
cd deploy && pulumi stack select organization/ops/ops-dev && pulumi preview --diff 2>&1 | tail -80
```

Expected, and each of these is a pass condition:
- 21 resources shown as `import`
- ZERO resources shown as `replace` or `delete`. A replace on a permission set
  is the failure this gate exists to catch. If you see one, STOP and report it
  rather than proceeding.
- Tag updates on the existing delegate resources, changing `Environment` from
  `dev` to `infra`. These are expected.

- [ ] **Step 4: Record the result**

Paste the preview summary into the PR body. If the preview cannot run (VPN,
credentials, missing `dist/lambda`), say so explicitly in the PR body rather
than implying it passed.

- [ ] **Step 5: Open PR1**

```bash
gh pr create --repo thegoodparty/serve-ops --base develop \
  --title "Bring Identity Center under IaC and tag ops resources as infra" \
  --body "<why, per spec; include the preview summary>"
```

PR body explains WHY, not WHAT. No test plan section. Link the spec.

---

### Task 6: Restrict EngineerAccess (PR2)

**Files:**
- Modify: `deploy/components/identity-center/policies/engineer-access.json`
- Test: `deploy/components/identity-center/policies.test.ts` (update the expected hash)

**Interfaces:**
- Consumes: Task 4's component
- Produces: the restriction

Branch off PR1's branch, not `develop`:

```bash
git checkout -b feat/engineer-infra-restrictions
```

Context: three edits. (a) closes a privilege-escalation path, (b) closes a
tag-blind S3/SQS hole, (c) backstops (a) unconditionally. All three are verified
in the spec with the IAM policy simulator.

- [ ] **Step 1: Edit (a), close the retag escalation**

In `engineer-access.json`, in the `DevResourceCreation` statement, change:

```json
"StringNotEquals": { "aws:ResourceTag/Environment": "prod" }
```

to:

```json
"StringNotEquals": { "aws:ResourceTag/Environment": ["prod", "infra"] }
```

Without this, an engineer can call `ecs:TagResource` on an infra resource with
`Environment=dev`, flip it back to dev, and then own it outright.

- [ ] **Step 2: Edits (b) and (c), append two Deny statements**

Append to the `Statement` array:

```json
{
  "Sid": "DenyInfraBucketAndQueueMutation",
  "Effect": "Deny",
  "Action": ["s3:Put*", "s3:Delete*", "s3:Create*", "s3:Replicate*",
             "sqs:Delete*", "sqs:Purge*", "sqs:Send*", "sqs:Set*",
             "sqs:Create*", "sqs:AddPermission", "sqs:RemovePermission"],
  "Resource": "*",
  "Condition": { "StringEquals": { "aws:ResourceTag/Environment": "infra" } }
},
{
  "Sid": "DenyInfraObjectMutation",
  "Effect": "Deny",
  "Action": ["s3:Put*", "s3:Delete*", "s3:Restore*", "s3:Abort*"],
  "Resource": ["arn:aws:s3:::gp-playwright-reports/*"]
},
{
  "Sid": "DenyIdentityCenterMutation",
  "Effect": "Deny",
  "Action": ["sso:Create*", "sso:Delete*", "sso:Update*", "sso:Put*",
             "sso:Attach*", "sso:Detach*", "sso:Provision*", "sso:Tag*",
             "sso:Untag*", "sso:Associate*", "sso:Disassociate*",
             "sso-directory:Create*", "sso-directory:Delete*",
             "sso-directory:Update*", "sso-directory:Add*",
             "sso-directory:Remove*", "identitystore:Create*",
             "identitystore:Delete*", "identitystore:Update*"],
  "Resource": "*"
}
```

Two things not to "improve":
- The object-level statement needs an explicit bucket ARN. Bucket tags do not
  propagate to objects, so `aws:ResourceTag` never matches on `s3:PutObject`
  and a tag condition there would silently do nothing.
- `DenyIdentityCenterMutation` enumerates write verbs deliberately. A `Deny`
  with `NotAction` and a read allowlist would deny every action in every
  service not on the list.

- [ ] **Step 3: Update the fixture hash**

The checksum test from Task 4 now fails by design: the file changed on purpose.

```bash
shasum -a 256 deploy/components/identity-center/policies/engineer-access.json
```

Replace the `engineer-access.json` value in `policies.test.ts` with the new hash.

- [ ] **Step 4: Validate the JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('deploy/components/identity-center/policies/engineer-access.json','utf8')); console.log('valid')"
```
Expected: `valid`

- [ ] **Step 5: Run tests**

Run: `npm test 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add deploy/components/identity-center/policies/engineer-access.json deploy/components/identity-center/policies.test.ts
git commit --no-verify -m "Restrict EngineerAccess from mutating infra resources

Closes a three-call path from engineer to full admin: tag a permission set
dev, inherit blanket dev access to it, then rewrite its inline policy. The
unconditional sso deny is the backstop, so the fix does not depend on a
permission set staying correctly tagged."
```

---

### Task 7: Verify the restriction with the policy simulator (PR2)

**Files:** none modified. Verification gate.

- [ ] **Step 1: Run the matrix**

```bash
ROLE=arn:aws:iam::333022194791:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_EngineerAccess_7125dde72761a2e6
POL=$(cat deploy/components/identity-center/policies/engineer-access.json)

deny() { printf '%-46s ' "$1"; aws iam simulate-custom-policy \
  --policy-input-list "$POL" --action-names "$1" --resource-arns "$2" \
  ${3:+--context-entries $3} --query 'EvaluationResults[].EvalDecision' --output text; }

deny sso:TagResource "*"
deny sso:PutInlinePolicyToPermissionSet "*"
deny sso:CreateAccountAssignment "*"
deny sso:DescribePermissionSet "*"
deny identitystore:ListUsers "*"
```

Expected: the first three `explicitDeny`, the last two `allowed`.

Note: `simulate-custom-policy` evaluates ONLY the inline policy. Engineers also
carry `ReadOnlyAccess` and `AmazonS3FullAccess` managed policies, so an
`implicitDeny` here does not prove a real-world deny. For actions that depend on
those managed policies, use `simulate-principal-policy` against `$ROLE` after
the change is deployed, not before.

- [ ] **Step 2: Open PR2 stacked on PR1**

```bash
gh pr create --repo thegoodparty/serve-ops --base feat/identity-center-iac \
  --title "Restrict EngineerAccess from mutating infra-tagged resources" \
  --body "<why; note it is stacked on PR1 and must merge after>"
```

- [ ] **Step 3: Report both PRs**

Report both URLs, their CI status, and explicitly state which verification steps
actually ran versus which were blocked.

---

## Remaining manual steps (not automatable in these PRs)

State these clearly when reporting. They are prerequisites for the deploy, not
for the PRs being green.

1. Grant `github-actions-pulumi-deploy` the `sso:*` and
   `identitystore:Describe*`/`List*` permissions in
   `GitHubActionsPulumiDeployPolicy`. Without it the deploy fails at `pulumi up`.
2. Set `require_code_owner_reviews: true` on the `develop` branch protection.
   Until then CODEOWNERS is advisory and delegate's approval still satisfies the
   1-approval requirement.
