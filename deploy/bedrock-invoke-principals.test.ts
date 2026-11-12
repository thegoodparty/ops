import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One invoke grant in the workbench account, and this is the file that says so.
 *
 * The requirement this pins is the whole point of the change: Bifrost is the
 * only path to a Bedrock model in the workbench account, so `bedrock:InvokeModel`
 * (and its three siblings) must appear as an **Allow** in exactly one policy
 * there — the gateway's task role in `deploy-workbench/ecs.ts` — and as a
 * **Deny** in exactly one, `WorkbenchAccess`.
 *
 * The infrastructure account has a second, deliberate principal since
 * `docs/swarm-bedrock.md`: the Delegate swarm's `delegate-swarm-bedrock` role in
 * `deploy-infrastructure/agent-swarm.ts`. It is named in the allowlist below
 * and its own module test pins the four actions and the two models, so this
 * file's job for it is only that it is a *named* file rather than a new one
 * nobody looked at. Everywhere else the workbench rule is unchanged.
 *
 * Why a source scan rather than importing each document. There are five Pulumi
 * projects and a dozen policy modules, several of which cannot be imported
 * without a Pulumi runtime, and the failure this catches is a *new* file
 * acquiring a grant rather than an existing one changing shape. A scan sees
 * every module whether or not anything imports it, which is what "no other
 * principal" actually means. The cost is that the match is textual: a grant
 * built by string concatenation would slip past it, and the module-level tests
 * (`identity-center-workbench.test.ts`, `ecs.test.ts`) are what cover the two
 * documents by structure instead.
 *
 * `kms`, `lambda` and the CI roles are unaffected and not scanned for; this is
 * about the Bedrock invoke family and nothing else.
 */

const REPO_ROOT = path.resolve(__dirname, "..");

/** The trees that can define an IAM policy or a role trust in this repo. */
const POLICY_TREES = [
  "deploy",
  "deploy-workbench",
  "deploy-org",
  "deploy-infrastructure",
  "utils",
  "scripts",
];

/**
 * The invoke family, spelled exactly. A wildcard such as `bedrock:*` is caught
 * separately: it would be a grant of everything, and the whole reason this file
 * exists is that the account had one of those once.
 */
const INVOKE_ACTIONS = [
  "bedrock:Converse",
  "bedrock:ConverseStream",
  "bedrock:InvokeModel",
  "bedrock:InvokeModelWithBidirectionalStream",
  "bedrock:InvokeModelWithResponseStream",
];

/** Every `.ts` file under a tree, tests excluded, with its repo-relative path. */
const sourceFiles = (tree: string): string[] => {
  const root = path.join(REPO_ROOT, tree);
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
};

type Hit = { file: string; line: number; text: string };

/**
 * Files that mention an invoke action, with the line that does.
 *
 * Comments count, and that is deliberate rather than sloppy: a policy module
 * explaining what it does *not* grant still has to read correctly, and a test
 * that tried to strip comments would be a parser. What is asserted below is
 * about *which files* may mention them at all, so a comment in a new file is
 * still a place a reviewer should look.
 */
const mentions = (): Hit[] => {
  const hits: Hit[] = [];
  for (const tree of POLICY_TREES) {
    for (const file of sourceFiles(tree)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((text, index) => {
        if (
          INVOKE_ACTIONS.some((action) => text.includes(action)) ||
          // A `bedrock:Invoke*` or `bedrock:*` wildcard covers the family
          // whether or not the full names appear.
          /bedrock:(Invoke|Converse)\*|["']bedrock:\*["']/.test(text)
        ) {
          hits.push({
            file: path.relative(REPO_ROOT, file),
            line: index + 1,
            text: text.trim(),
          });
        }
      });
    }
  }
  return hits;
};

describe("the workbench account's Bedrock invoke grants", () => {
  // Every file, by name, so adding a fourth is a review question rather than a
  // quiet widening. `utils/bedrock-models.ts` is here because its docstring
  // explains the grant and it defines no action of its own; `deploy-org/`
  // because an SCP exempts the service from its region deny, which is routing
  // and can only subtract permission (asserted below);
  // `deploy-infrastructure/agent-swarm.ts` because it is the swarm's one
  // invoke grant, in the other account, and the below asserts it stays scoped
  // to the two models rather than turning into a second blanket allow.
  it("mentions the invoke actions in exactly these policy files and the list", () => {
    const files = [...new Set(mentions().map((hit) => hit.file))].sort();
    assert.deepEqual(files, [
      "deploy-infrastructure/agent-swarm.ts",
      "deploy-org/policies.ts",
      "deploy-workbench/ecs.ts",
      "deploy/components/identity-center/policies.ts",
      "utils/bedrock-models.ts",
    ]);
  });

  // The swarm role is the second allow, and it is not a second gateway: the
  // four invoke actions are declared once each, in one statement, on the model
  // ARNs. Its other statement is the two catalog reads its `BEDROCK_AUTH_MODE=sdk`
  // probe makes, which grant no invocation at all. The model scope itself is
  // asserted in `deploy-infrastructure/agent-swarm.test.ts`, which reads the
  // document as data; here the point is that this file was not widened into a
  // blanket grant behind the model list's back.
  it("allows them in the swarm role, scoped and never wildcarded", () => {
    const swarm = fs.readFileSync(
      path.join(REPO_ROOT, "deploy-infrastructure/agent-swarm.ts"),
      "utf8"
    );

    for (const action of INVOKE_ACTIONS.filter(
      (a) => a !== "bedrock:InvokeModelWithBidirectionalStream"
    )) {
      const occurrences = swarm.split(`"${action}"`).length - 1;
      assert.equal(
        occurrences,
        1,
        `${action} appears ${occurrences} times in deploy-infrastructure/agent-swarm.ts; it belongs in the swarm's single invoke statement alone`
      );
    }

    assert.equal(
      /["']bedrock:\*["']/.test(swarm),
      false,
      "agent-swarm.ts names bedrock:* ; the six named actions are the allowlist"
    );
    assert.equal(
      swarm.includes("bedrock:InvokeModelWithBidirectionalStream"),
      false,
      "the swarm role does not grant the bidirectional stream form"
    );
    assert.match(
      swarm,
      /Sid: "InvokeSwarmBedrockModels",[\s\S]{0,300}Resource: swarmBedrockInvokeResources\(\)/
    );
    // The control-plane reads are named, not wildcarded, and are confined to
    // `bedrock:List`: the probe lists the catalog and does not describe it. The
    // match is on quoted actions, so the docstring's explanation of what is
    // absent (which names `bedrock:Get*` in prose) does not trip it.
    assert.match(
      swarm,
      /Sid: "ProbeBedrockCatalog",[\s\S]{0,200}Action: \[\.\.\.SWARM_BEDROCK_READ_ACTIONS\]/
    );
    assert.equal(
      /["']bedrock:Get/.test(swarm),
      false,
      "agent-swarm.ts grants a Bedrock Get; the sdk probe only lists"
    );
  });

  // The allow side: `ecs.ts` names the actions as data, and `TASK_BEDROCK_ACTIONS`
  // is the only place an allow can come from in the workbench account.
  // `deploy-workbench/` has one task role, and `ecs.test.ts` asserts its policy
  // is built from that constant, so the string appearing there once is the
  // whole grant.
  it("allows them once each in the gateway's task role", () => {
    const ecsSource = fs.readFileSync(
      path.join(REPO_ROOT, "deploy-workbench/ecs.ts"),
      "utf8"
    );

    // The declarations, exactly once each: the constant, and the statement that
    // spreads it. A second `Action: [...]` block naming the actions by hand
    // would be a second grant in the same role.
    for (const action of INVOKE_ACTIONS.filter(
      (a) => a !== "bedrock:InvokeModelWithBidirectionalStream"
    )) {
      const occurrences = ecsSource.split(`"${action}"`).length - 1;
      assert.equal(
        occurrences,
        1,
        `${action} appears ${occurrences} times in deploy-workbench/ecs.ts; it belongs in TASK_BEDROCK_ACTIONS alone`
      );
    }

    // And nothing in that module grants them broadly. `bedrock:*` in `ecs.ts`
    // would make the constant above decoration.
    assert.equal(
      /["']bedrock:\*["']/.test(ecsSource),
      false,
      "ecs.ts names bedrock:* ; the model list is the allowlist"
    );

    // The task role itself, rather than any other role in the module: the
    // execution role holds no Bedrock action at all, which `ecs.test.ts`
    // asserts directly. Here it is enough that the statement carrying the
    // constant is the one named for the invocation.
    assert.match(
      ecsSource,
      /Sid: "InvokeSelectedBedrockModels",[\s\S]{0,200}Action: \[\.\.\.TASK_BEDROCK_ACTIONS\]/
    );
  });

  // The deny side, and the one place the actions must appear as a Deny.
  it("denies them only in WorkbenchAccess", () => {
    const policies = fs.readFileSync(
      path.join(REPO_ROOT, "deploy/components/identity-center/policies.ts"),
      "utf8"
    );

    // `WorkbenchAccess` is the only permission set that names them at all. Every
    // other set in that module is either unrelated or reads only, and a second
    // Deny elsewhere would be a second decision nobody recorded.
    const assignments = policies
      .split("\n")
      .filter((line) => INVOKE_ACTIONS.some((action) => line.includes(`"${action}"`)));
    assert.equal(
      assignments.length,
      INVOKE_ACTIONS.length,
      "each invoke action appears once, in the Deny's Action list"
    );

    // No wildcard anywhere in that module: `bedrock:*` on the Deny would shadow
    // the catalog reads (`ReadBedrockCatalogAndState`), and `bedrock:*` on an
    // Allow is the grant this change removes.
    assert.equal(
      /["']bedrock:\*["']/.test(policies),
      false,
      "policies.ts names bedrock:* ; a Deny would shadow the reads and an Allow would restore the direct path"
    );
  });

  // The organisation SCP exempts the whole service from its region deny, and
  // that is a routing requirement rather than a grant. Asserted so nobody reads
  // the exemption as a permission: an SCP can only deny, so a name in this list
  // is a service the region deny does not reach.
  it("keeps the SCP's bedrock exemption, which is routing and not a grant", () => {
    const scp = fs.readFileSync(
      path.join(REPO_ROOT, "deploy-org/policies.ts"),
      "utf8"
    );
    // The `bedrock:*` string is in the exemption list, and that list is only
    // ever read by a `Deny` on the region condition. If it were ever moved into
    // an Allow this test would still pass, which is why the SCP's own module
    // test (`deploy-workbench`'s SCP assertions) is the control that matters.
    assert.match(scp, /const REGION_EXEMPT_SERVICES = \[[\s\S]*?"bedrock:\*",/);
    // And the file defines no invoke action and no `Allow` naming the family.
    for (const action of INVOKE_ACTIONS) {
      assert.equal(
        scp.includes(`"${action}"`),
        false,
        `deploy-org/policies.ts names ${action}; the SCP is routing, not a grant`
      );
    }
  });
});
