import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHumanAdapter,
  humanSignal,
  isNeverSuppressed,
} from "./human";
import { createIngress, createIngressRegistry } from "./index";
import { createGrafanaAdapter } from "./grafana";

const NOW = 1_764_000_000_000;
const now = () => NOW;

const body = (payload: unknown) => ({
  headers: {},
  rawBody: JSON.stringify(payload),
});

// --- the four things that differ from an alert ----------------------------

test("there is nothing to pre-fetch: the description is the evidence", async () => {
  const adapter = createHumanAdapter({ now });
  const [signal] = await adapter.parse(
    body({ text: "Pro upgrades 500 on submit", reportedBy: "U0HUMAN" }),
  );
  assert.deepEqual(await adapter.prefetchEvidence(signal), []);
  assert.equal(signal.body, "Pro upgrades 500 on submit");
});

test("a human report is never suppressed", () => {
  const signal = humanSignal({
    text: "checkout is broken",
    reportedBy: "U0HUMAN",
    via: "mcp",
    reportedAt: NOW,
  });
  assert.equal(signal.labels.never_suppress, "true");
  assert.equal(isNeverSuppressed(signal), true);
  assert.equal(signal.labels.resolution_policy, "verification");
});

test("there is a stakeholder to notify", () => {
  const signal = humanSignal({
    text: "checkout is broken",
    reportedBy: "U0HUMAN",
    via: "slack",
    channel: "C0BUGS",
    threadTs: "1764000000.000001",
    messageTs: "1764000000.000200",
    reportedAt: NOW,
  });
  assert.equal(signal.reportedBy, "U0HUMAN");
  assert.equal(signal.labels.slack_channel, "C0BUGS");
  assert.equal(signal.labels.slack_thread_ts, "1764000000.000001");
  assert.equal(signal.labels.reported_via, "slack");
});

// --- shape -----------------------------------------------------------------

test("the title is the first line and the body is the whole report", () => {
  const signal = humanSignal({
    text: "\n  Pro upgrades look broken  \n\nSteps: click upgrade, get a 500.\n",
    reportedBy: "U0HUMAN",
    via: "mcp",
    reportedAt: NOW,
  });
  assert.equal(signal.title, "Pro upgrades look broken");
  assert.match(signal.body, /Steps: click upgrade/);
  assert.equal(signal.source, "human");
  assert.equal(signal.kind, "bug_report");
  assert.equal(signal.openedAt, NOW);
});

test("a very long first line is truncated for the title only", () => {
  const long = "x".repeat(300);
  const signal = humanSignal({
    text: long,
    reportedBy: "U0HUMAN",
    via: "mcp",
    reportedAt: NOW,
  });
  assert.equal(signal.title.length, 120);
  assert.ok(signal.title.endsWith("…"));
  assert.equal(signal.body.length, 300);
});

test("an empty report or an unattributed one is refused", () => {
  assert.throws(
    () => humanSignal({ text: "   ", reportedBy: "U0HUMAN", via: "mcp" }),
    /report text is empty/,
  );
  assert.throws(
    () => humanSignal({ text: "broken", reportedBy: "", via: "mcp" }),
    /report has no reporter/,
  );
});

// --- dedup -----------------------------------------------------------------

test("an MCP report dedups on its content when no id is given", () => {
  const report = { text: "checkout is broken", reportedBy: "U0HUMAN", via: "mcp" as const };
  const a = humanSignal(report);
  const b = humanSignal(report);
  assert.equal(a.sourceId, b.sourceId);
  assert.match(a.sourceId, /^mcp:[0-9a-f]{16}$/);

  const other = humanSignal({ ...report, reportedBy: "U0OTHER" });
  assert.notEqual(a.sourceId, other.sourceId, "a different reporter is a different report");
});

test("an explicit id wins over the derived one", () => {
  const signal = humanSignal({
    text: "checkout is broken",
    reportedBy: "U0HUMAN",
    via: "mcp",
    id: "tool-call-42",
  });
  assert.equal(signal.sourceId, "tool-call-42");
});

test("the same report over Slack and over MCP shares a dedup key shape", () => {
  const adapter = createHumanAdapter({ now });
  const viaMcp = humanSignal({ text: "broken", reportedBy: "U0HUMAN", via: "mcp", id: "r-1" });
  assert.equal(adapter.dedupKey(viaMcp), "human:r-1");
});

// --- the MCP entry point ---------------------------------------------------

test("the MCP payload is validated rather than defaulted", async () => {
  const adapter = createHumanAdapter({ now });
  await assert.rejects(adapter.parse({ headers: {}, rawBody: "{" }), /body was not JSON/);
  await assert.rejects(
    adapter.parse(body({ text: "broken" })),
    /report has no reporter/,
  );
  await assert.rejects(
    adapter.parse(body({ reportedBy: "U0HUMAN" })),
    /report text is empty/,
  );
  await assert.rejects(adapter.parse(body([1, 2, 3])), /report text is empty/);
});

test("an MCP report defaults to via mcp and to now", async () => {
  const [signal] = await createHumanAdapter({ now }).parse(
    body({ text: "broken", reportedBy: "U0HUMAN" }),
  );
  assert.equal(signal.labels.reported_via, "mcp");
  assert.equal(signal.openedAt, NOW);
});

// --- the registry ----------------------------------------------------------

test("the registry is keyed by source name", () => {
  const registry = createIngress({ grafana: { secret: "s" } });
  assert.deepEqual(registry.list().sort(), ["grafana", "human", "slack"]);
  assert.equal(registry.has("grafana"), true);
  assert.equal(registry.has("sentry"), false);
  assert.equal(registry.get("human").source, "human");
});

test("an unknown source names what is available", () => {
  const registry = createIngress();
  assert.throws(() => registry.get("sentry"), /Available: grafana, slack, human/);
});

test("two adapters claiming one source is a build error, not a silent overwrite", () => {
  assert.throws(
    () =>
      createIngressRegistry([
        createGrafanaAdapter({ secret: "a" }),
        createGrafanaAdapter({ secret: "b" }),
      ]),
    /Duplicate ingress adapter/,
  );
});
