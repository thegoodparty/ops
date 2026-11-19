import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { withAdminReserved } from "./components/identity-center";
import { engineerAccess } from "./components/identity-center/policies";

// `EngineerAccess` has guardrails on, so the document Pulumi serialises is
// `adminReservedActions` prepended to `engineerAccess`, not the export on its
// own. Assert on the composed document, which is the one that reaches IAM.
const composed = withAdminReserved(engineerAccess);

// A deliberate second copy of `BEDROCK_SERVICE_PREFIXES` in the policy module.
// The duplication is the point: adding a prefix there without extending the
// exclusions and the read grant here fails this test. Nothing can detect a
// prefix AWS adds later, so that case is a comment in the policy, not a test.
const BEDROCK_FAMILY = [
  "bedrock",
  "bedrock-agentcore",
  "bedrock-mantle",
  "bedrock-websearch",
];

// A deliberate second copy of the browser session actions, for the same reason
// as the prefix list: the set is a grant, and a second copy here is what makes
// a widened grant visible in review rather than in an AccessDenied transcript.
// These are the actions gp-api's agent web tools call -- start a session, look
// it up, list, stop, and the CDP stream the tools drive it over. They match
// `GpApiPreviewRoleBoundary` in `deploy/components/ci-roles/policies.ts`, so a
// preview and a laptop under this profile exercise the same browser path.
const AGENTCORE_BROWSER_SESSION_ACTIONS = [
  "bedrock-agentcore:StartBrowserSession",
  "bedrock-agentcore:GetBrowserSession",
  "bedrock-agentcore:ListBrowserSessions",
  "bedrock-agentcore:StopBrowserSession",
  "bedrock-agentcore:ConnectBrowserAutomationStream",
];

// The AWS-managed browser, in the region every stack here deploys to. Not the
// account's own browsers: those carry their execution role and network
// settings, so allowing a session on one is a grant over somebody else's
// choice of role.
const AGENTCORE_MANAGED_BROWSER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:aws:browser/aws.browser.v1";

const asList = (value: unknown): string[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? (value as string[])
      : [value as string];

describe("EngineerAccess", () => {
  // The grant that stops a laptop `pi` running under this profile invoking a
  // model and causing Bedrock to subscribe it in the management account.
  it("allows Bedrock-family reads and nothing else", () => {
    const allow = composed.Statement.find(
      (s) => s.Sid === "ReadBedrockCatalog"
    );
    assert.ok(allow, "no ReadBedrockCatalog statement");
    assert.equal(allow.Effect, "Allow");
    assert.deepEqual(
      asList(allow.Action),
      BEDROCK_FAMILY.flatMap((prefix) => [
        `${prefix}:Get*`,
        `${prefix}:List*`,
      ])
    );
  });

  // `Resource: "*"` is what the blanket grants look like, and the browser
  // grant next to them would be indistinguishable from one at a glance. Pinned
  // because the failure it prevents -- a browser session on any account's
  // browser -- is silent until something starts paying for one.
  it("names no wildcard resource for the browser grant", () => {
    const browser = composed.Statement.find(
      (s) => s.Sid === "AgentCoreManagedBrowser"
    );
    assert.ok(browser, "no AgentCoreManagedBrowser statement");
    assert.ok(!asList(browser.Resource).includes("*"), "browser grant is *");
    assert.ok(
      !asList(browser.Action).some((a) => a.endsWith("*")),
      "browser grant names a wildcard action"
    );
  });

  // The two tag-conditioned blanket grants would otherwise reach the Bedrock
  // family, because its invoke and create actions list `aws:RequestTag` among
  // their condition keys. Excluding the whole family, not just `bedrock:*`, is
  // what makes the read grant above the only Bedrock path. A Deny with
  // `NotAction` is the obvious alternative and is wrong: `NotAction` is
  // evaluated across every service, so it would deny S3, SQS, Transcribe and
  // the rest of the set too.
  it("excludes the whole Bedrock family from both blanket grants", () => {
    const expected = BEDROCK_FAMILY.map((prefix) => `${prefix}:*`);
    for (const sid of ["DevResourceOperations", "DevResourceCreation"]) {
      const statement = composed.Statement.find((s) => s.Sid === sid);
      assert.ok(statement, `no ${sid} statement`);
      assert.equal(statement.Effect, "Allow");
      assert.deepEqual(asList(statement.NotAction), expected);
      assert.equal(statement.Action, undefined, `${sid} still names Action`);
    }
  });

  // A regression can also take the shape of a new explicit Allow for an invoke
  // or mutation, which the exclusions above would not catch. The browser
  // session actions are the one deliberate exception, and they are named from
  // the list above rather than pattern-matched, so widening the grant means
  // editing that list too.
  it("allows no Bedrock-family action other than a read or a browser session", () => {
    const family = /^(bedrock|bedrock-agentcore|bedrock-mantle|bedrock-websearch):/;
    const read = /^(bedrock|bedrock-agentcore|bedrock-mantle|bedrock-websearch):(Get|List)/;
    for (const statement of composed.Statement) {
      if (statement.Effect !== "Allow") continue;
      for (const action of asList(statement.Action)) {
        if (!family.test(action)) continue;
        if (AGENTCORE_BROWSER_SESSION_ACTIONS.includes(action)) continue;
        assert.ok(
          read.test(action),
          `${statement.Sid ?? "(no Sid)"} allows non-read ${action}`
        );
      }
    }
  });

  // Engineers run and test gp-api's agent web tools locally under the
  // `gp-engineer` profile, so this profile needs the same browser session
  // actions a preview task role has. Nothing wider: no `CreateBrowser` or
  // `DeleteBrowser` (a session on the managed browser needs neither), no custom
  // browser ARN, no live-view stream, and nothing from AgentCore's runtime or
  // code-interpreter surfaces.
  //
  // Two statements name the prefix, and no more: this one and the catalog
  // reads. `bedrock-agentcore:Get*` and `List*` there already matched some of
  // the session reads, so the point of the browser statement is the three
  // mutations, and a third statement naming the prefix would be a grant nobody
  // recorded.
  it("allows AgentCore browser sessions on the managed browser only", () => {
    const agentCore = composed.Statement.filter((s) =>
      asList(s.Action).some((a) => a.startsWith("bedrock-agentcore:"))
    );
    assert.deepEqual(
      agentCore.map((s) => s.Sid),
      ["ReadBedrockCatalog", "AgentCoreManagedBrowser"]
    );
    const browser = agentCore[1];
    assert.equal(browser.Effect, "Allow");
    assert.deepEqual(asList(browser.Action), AGENTCORE_BROWSER_SESSION_ACTIONS);
    assert.deepEqual(asList(browser.Resource), [AGENTCORE_MANAGED_BROWSER_ARN]);
    assert.equal(browser.NotResource, undefined);
    assert.equal(browser.Condition, undefined);
  });

  // `accounts` is private to the component, so this reads the source, the
  // same way identity-center-administrator.test.ts does.
  it("is assigned to Engineers in the infrastructure account, with ReadOnlyAccess", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "components/identity-center.ts"),
      "utf8"
    );
    const infrastructure = source.match(
      /infrastructure: \{\s*id: INFRASTRUCTURE_ACCOUNT_ID,[\s\S]*?assignments: \{([\s\S]*?)\}/
    );
    assert.ok(infrastructure, "no infrastructure account entry");
    assert.match(infrastructure[1], /Engineers: \["engineer", "readOnly"\],/);
  });
});
