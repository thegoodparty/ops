import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import { bundleCommits, errorResult, prepareReplaySide, type PreparedReplay } from "./replay-side";

const run = promisify(execFile);

// A small synthetic Pi session. No production data. The last two entries
// come after the PR opened, so the cut must leave them out.
const entry = (id: string, body: Record<string, unknown>) =>
  JSON.stringify({ id, parentId: null, timestamp: "2026-09-29T00:00:00.000Z", ...body });
const call = (id: string, at: number, name: string, args: Record<string, unknown>) =>
  entry(`a-${id}`, { type: "message", message: { role: "assistant", timestamp: at, content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id: string, name: string, text: string) =>
  entry(`r-${id}`, { type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, isError: false, content: [{ type: "text", text }] } });
const SESSION = [
  JSON.stringify({ type: "session", version: 3, id: "7", timestamp: "2026-09-29T00:00:00.000Z", cwd: "/work/7/omni" }),
  call("c1", 1000, "get_incident", {}),
  result("c1", "get_incident", `ok\n\n${JSON.stringify({ incident: { id: "7", status: "FIXING" }, signals: [] })}`),
  call("c2", 2000, "bash", { command: 'gh pr create --base main --head fix/pool --title "Bound the pool" --body "Why."' }),
  result("c2", "bash", "https://github.com/thegoodparty/omni/pull/2213"),
  call("c3", 3000, "bash", { command: "echo AFTER-THE-PR" }),
  result("c3", "bash", "AFTER-THE-PR"),
].join("\n");

describe("a Tier 2 side's run directory and compose file", () => {
  let fixtures: string;
  let prepared: PreparedReplay;
  let shas: { base: string; head: string };

  before(async () => {
    fixtures = mkdtempSync(join(tmpdir(), "replay-side-"));
    const caseJson = join(fixtures, "case.json");
    writeFileSync(
      caseJson,
      JSON.stringify({
        id: "incident-7-post-pr",
        sourceIncident: 7,
        phase: "post_pr",
        checkpoint: { session: "s3://no-such-bucket-for-this-test/sessions/incident/7/session.jsonl", prOrdinal: 1 },
        script: [{ on: "any", reply: "ok" }],
        ci: { verdicts: [{ conclusion: "success" }] },
        stop: { turnCap: 5 },
        caps: { wallClockSeconds: 600, modelUsd: 2 },
        scenario: null,
        noVettedReference: true,
      }),
    );
    writeFileSync(join(fixtures, "session.jsonl"), SESSION);

    const variant = join(fixtures, "variant-src");
    mkdirSync(join(variant, "bugboss"), { recursive: true });
    writeFileSync(join(variant, "package.json"), "{}");
    await run("tar", ["-cf", join(fixtures, "variant.tar"), "-C", variant, "."]);

    const repo = join(fixtures, "omni");
    const git = (...args: string[]) => run("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    mkdirSync(repo);
    await git("init", "--quiet");
    await git("commit", "--quiet", "--allow-empty", "-m", "base");
    shas = { base: "", head: "" };
    shas.base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("commit", "--quiet", "--allow-empty", "-m", "head");
    shas.head = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("update-ref", "refs/replay/base", shas.base);
    await git("update-ref", "refs/replay/head", shas.head);
    await git("bundle", "create", join(fixtures, "omni.bundle"), "refs/replay/head", "refs/replay/base");

    prepared = await prepareReplaySide({
      caseJson,
      ref: "abc123",
      rep: 2,
      runId: "replay-probe",
      simImage: "sim:test",
      workRoot: join(fixtures, "work"),
      variantTar: join(fixtures, "variant.tar"),
      checkpoint: join(fixtures, "session.jsonl"),
      omniBundle: join(fixtures, "omni.bundle"),
      modelCredentials: "none",
      out: join(fixtures, "out"),
    });
  });

  after(() => rmSync(fixtures, { recursive: true, force: true }));

  test("the replay container is on internal networks only, and reaches the stand-ins' control listeners", async () => {
    const { stdout } = await prepared.compose(["config", "--format", "json"]);
    const config = JSON.parse(stdout) as {
      services: Record<string, { networks?: Record<string, { ipv4_address?: string } | null>; environment?: Record<string, string>; command?: string[] }>;
      networks: Record<string, { internal?: boolean }>;
    };
    assert.equal(config.networks.sim.internal, true);
    assert.equal(config.networks.control.internal, true);
    assert.deepEqual(Object.keys(config.services.replay.networks ?? {}).sort(), ["control", "sim"]);
    const onEgress = Object.entries(config.services)
      .filter(([, service]) => Object.keys(service.networks ?? {}).includes("egress"))
      .map(([name]) => name)
      .sort();
    assert.deepEqual(onEgress, ["npm", "proxy"], "the only containers with a route out");
    for (const name of ["proxy", "github"]) {
      const bind = config.services[name].environment?.CONTROL_HOST;
      assert.equal(bind, config.services[name].networks?.control?.ipv4_address, `${name} binds its control port to its control address`);
    }
    assert.equal(config.services.github.environment?.CI_MODE, "scripted");
    assert.equal(config.services.proxy.environment?.PROXY_BUDGET_USD, "2", "the proxy's budget is the case's cap");
    const command = config.services.replay.command ?? [];
    const flag = (name: string) => command[command.indexOf(name) + 1];
    assert.equal(flag("--head-sha"), shas.head);
    assert.equal(flag("--base-sha"), shas.base);
    assert.equal(flag("--rep"), "2");
    assert.equal(flag("--case"), "/app/bugboss-evals/replay/cases/incident-7-post-pr.json");
    assert.ok(command.includes("--skip-reference-check"));
    assert.equal(config.services.replay.environment?.CONTROL_TOKEN, "", "the replay container's own CONTROL_TOKEN is blank");
  });

  test("only the model proxy can read model credentials, and nothing mounts an AWS profile or the docker socket", async () => {
    const { stdout } = await prepared.compose(["config", "--format", "json"]);
    const config = JSON.parse(stdout) as {
      services: Record<string, { volumes?: { source?: string; target: string }[]; environment?: Record<string, string> }>;
    };
    const readers = Object.entries(config.services)
      .filter(([, service]) => (service.volumes ?? []).some((volume) => volume.source === join(prepared.runDir, "model-aws")))
      .map(([name]) => name);
    assert.deepEqual(readers, ["proxy"]);
    assert.equal(config.services.proxy.environment?.AWS_EC2_METADATA_DISABLED, "true");
    assert.equal(config.services.replay.environment?.AWS_EC2_METADATA_DISABLED, "true");
    for (const [name, service] of Object.entries(config.services)) {
      for (const volume of service.volumes ?? []) {
        assert.ok(!/\.aws$/.test(volume.source ?? ""), `${name} mounts an AWS profile directory: ${volume.source}`);
        assert.ok(!/docker\.sock$/.test(volume.source ?? ""), `${name} mounts the docker socket`);
      }
    }
    const work = (config.services.replay.volumes ?? []).find((volume) => volume.target === "/work");
    assert.ok(work, "the replay container has /work");
    for (const [name, service] of Object.entries(config.services)) {
      if (name !== "replay") assert.ok(!(service.volumes ?? []).some((volume) => volume.target === "/work"), `${name} shares /work`);
    }
    assert.ok(!existsSync(join(prepared.runDir, "model-aws", "session.json")), "a zero-spend side writes no session");
  });

  test("the replay container gets the cut checkpoint only, and the variant unpacked", () => {
    const cut = readFileSync(join(prepared.runDir, "checkpoint", "session.jsonl"), "utf8");
    assert.ok(cut.includes("pull/2213"));
    assert.ok(!cut.includes("AFTER-THE-PR"), "the recorded turns after the PR opened stay with the runner");
    assert.ok(existsSync(join(prepared.runDir, "variant", "package.json")));
    assert.ok(!existsSync(join(prepared.runDir, "variant.tar")));
  });
});

describe("replay bundles and results", () => {
  test("a bundle without the replay refs is refused, with how to build one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-"));
    try {
      const git = (...args: string[]) => run("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      await git("init", "--quiet", "-b", "main");
      await git("commit", "--quiet", "--allow-empty", "-m", "x");
      await git("bundle", "create", join(dir, "b.bundle"), "main");
      await assert.rejects(bundleCommits(join(dir, "b.bundle")), /replay-bundle/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a side that wrote nothing is recorded as an error that compare can still pair", () => {
    const recorded = errorResult({ caseId: "c", rep: 1, ref: "r", detail: "no result" });
    assert.equal(recorded.run.status, "error");
    assert.deepEqual(recorded.output, { rootCause: null, diff: null, postmortem: null });
  });
});
