import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import {
  DescribeServicesCommand,
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
} from "@aws-sdk/client-ecs";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import type { AwsData } from "../aws-data";
import { decode, encode, type Value } from "./cbor";
import { createAwsStandin, datapointMs, startAwsStandin } from "./server";

const ALERT_AT = Date.UTC(2026, 8, 29, 12, 0, 0);
const TOKEN = "control-secret";

const DATA: AwsData = {
  cloudwatch: [
    {
      namespace: "AWS/RDS",
      metricName: "DatabaseConnections",
      dimensions: { DBClusterIdentifier: "election-api-db-prod" },
      unit: "Count",
      datapoints: [
        { ts: -600_000, value: 10 },
        { ts: -590_000, value: 20 },
        { ts: -300_000, value: 50 },
        { ts: -60_000, value: 99 },
        { ts: ALERT_AT - 3_600_000 * 48, value: 1 },
      ],
    },
    {
      namespace: "AWS/ECS",
      metricName: "CPUUtilization",
      dimensions: { ClusterName: "election-api", ServiceName: "election-api" },
      unit: "Percent",
      datapoints: [{ ts: -120_000, value: 42 }],
    },
  ],
  ecs: {
    clusters: ["election-api"],
    services: [
      {
        cluster: "election-api",
        name: "election-api",
        desiredCount: 2,
        runningCount: 2,
        taskDefinition: "election-api:41",
      },
    ],
  },
  secretsManager: { names: ["ELECTION_API_PROD", "GP_API_PROD"] },
};

const credentials = { accessKeyId: "AKIASIMFAKE", secretAccessKey: "fake" };

let publicServer: Server;
let controlServer: Server;
let endpoint: string;
let controlUrl: string;

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

before(async () => {
  const standin = createAwsStandin({
    data: DATA,
    alertAt: ALERT_AT,
    controlToken: TOKEN,
  });
  publicServer = createServer(standin.handle);
  controlServer = createServer(standin.handleControl);
  endpoint = await listen(publicServer);
  controlUrl = await listen(controlServer);
});

after(() => {
  publicServer.close();
  controlServer.close();
});

const control = (path: string, init: RequestInit = {}) =>
  fetch(`${controlUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });

const scope = (service: string) =>
  `AWS4-HMAC-SHA256 Credential=AKIASIMFAKE/20260929/us-west-2/${service}/aws4_request, SignedHeaders=host, Signature=00`;

test("relative datapoint offsets are milliseconds from the alert", () => {
  assert.equal(datapointMs({ ts: -21_600_000, value: 0 }, ALERT_AT), ALERT_AT - 21_600_000);
  assert.equal(datapointMs({ ts: 0, value: 0 }, ALERT_AT), ALERT_AT);
  assert.equal(datapointMs({ ts: ALERT_AT - 5, value: 0 }, ALERT_AT), ALERT_AT - 5);
});

test("the real ECS SDK lists clusters and describes services with deployments and events", async () => {
  const ecs = new ECSClient({ region: "us-west-2", endpoint, credentials });
  const clusters = await ecs.send(new ListClustersCommand({}));
  assert.deepEqual(clusters.clusterArns, [
    "arn:aws:ecs:us-west-2:123456789012:cluster/election-api",
  ]);
  const listed = await ecs.send(
    new ListServicesCommand({ cluster: "election-api" }),
  );
  assert.equal(listed.serviceArns?.length, 1);
  const described = await ecs.send(
    new DescribeServicesCommand({
      cluster: "election-api",
      services: ["election-api", "nope"],
    }),
  );
  const service = described.services?.[0];
  assert.equal(service?.serviceName, "election-api");
  assert.equal(service?.runningCount, 2);
  assert.equal(service?.deployments?.[0]?.status, "PRIMARY");
  assert.ok(service?.deployments?.[0]?.createdAt instanceof Date);
  assert.match(service?.events?.[0]?.message ?? "", /steady state/);
  assert.equal(described.failures?.[0]?.reason, "MISSING");
});

test("the real Secrets Manager SDK lists and describes names but never reads a value", async () => {
  const sm = new SecretsManagerClient({
    region: "us-west-2",
    endpoint,
    credentials,
  });
  const listed = await sm.send(new ListSecretsCommand({}));
  assert.deepEqual(
    listed.SecretList?.map((s) => s.Name),
    ["ELECTION_API_PROD", "GP_API_PROD"],
  );
  const one = await sm.send(
    new DescribeSecretCommand({ SecretId: "GP_API_PROD" }),
  );
  assert.equal(one.Name, "GP_API_PROD");
  await assert.rejects(
    sm.send(new GetSecretValueCommand({ SecretId: "GP_API_PROD" })),
    (error: Error) => error.name === "AccessDeniedException",
  );
});

const statsWindow = {
  start: ALERT_AT - 900_000,
  end: ALERT_AT,
};

test("CloudWatch over awsQuery aggregates datapoints into periods and answers XML", async () => {
  const body = new URLSearchParams({
    Action: "GetMetricStatistics",
    Version: "2010-08-01",
    Namespace: "AWS/RDS",
    MetricName: "DatabaseConnections",
    "Dimensions.member.1.Name": "DBClusterIdentifier",
    "Dimensions.member.1.Value": "election-api-db-prod",
    StartTime: new Date(statsWindow.start).toISOString(),
    EndTime: new Date(statsWindow.end).toISOString(),
    Period: "300",
    "Statistics.member.1": "Maximum",
    "Statistics.member.2": "SampleCount",
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: scope("monitoring"),
    },
    body,
  });
  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.match(xml, /xmlns="http:\/\/monitoring\.amazonaws\.com\/doc\/2010-08-01\/"/);
  assert.match(xml, /<GetMetricStatisticsResult>/);
  const maxima = [...xml.matchAll(/<Maximum>([^<]+)<\/Maximum>/g)].map((m) =>
    Number(m[1]),
  );
  assert.deepEqual(maxima, [20, 99]);
  const counts = [...xml.matchAll(/<SampleCount>([^<]+)<\/SampleCount>/g)].map(
    (m) => Number(m[1]),
  );
  assert.deepEqual(counts, [2, 2]);
  assert.doesNotMatch(xml, /<Maximum>1<\/Maximum>/, "the 48h-old point is outside the window");
});

test("CloudWatch over awsJson1_0 answers ListMetrics and GetMetricData", async () => {
  const call = (op: string, payload: object) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `GraniteServiceVersion20100801.${op}`,
        authorization: scope("monitoring"),
      },
      body: JSON.stringify(payload),
    });

  const metrics = (await (
    await call("ListMetrics", { Namespace: "AWS/ECS" })
  ).json()) as { Metrics: { MetricName: string }[] };
  assert.deepEqual(
    metrics.Metrics.map((m) => m.MetricName),
    ["CPUUtilization"],
  );

  const data = (await (
    await call("GetMetricData", {
      StartTime: statsWindow.start / 1000,
      EndTime: statsWindow.end / 1000,
      MetricDataQueries: [
        {
          Id: "conns",
          MetricStat: {
            Metric: {
              Namespace: "AWS/RDS",
              MetricName: "DatabaseConnections",
              Dimensions: [
                { Name: "DBClusterIdentifier", Value: "election-api-db-prod" },
              ],
            },
            Period: 300,
            Stat: "Average",
          },
        },
      ],
    })
  ).json()) as {
    MetricDataResults: { Id: string; Values: number[]; Timestamps: number[] }[];
  };
  const result = data.MetricDataResults[0];
  assert.equal(result.Id, "conns");
  assert.deepEqual(result.Values, [74.5, 15], "newest first by default");
  assert.ok(result.Timestamps[0] > result.Timestamps[1]);
});

test("CloudWatch over rpc-v2-cbor answers GetMetricStatistics with tag 1 timestamps", async () => {
  const response = await fetch(
    `${endpoint}/service/GraniteServiceVersion20100801/operation/GetMetricStatistics`,
    {
      method: "POST",
      headers: {
        "content-type": "application/cbor",
        "smithy-protocol": "rpc-v2-cbor",
        authorization: scope("monitoring"),
      },
      body: new Uint8Array(encode({
        Namespace: "AWS/RDS",
        MetricName: "DatabaseConnections",
        Dimensions: [
          { Name: "DBClusterIdentifier", Value: "election-api-db-prod" },
        ],
        StartTime: new Date(statsWindow.start),
        EndTime: new Date(statsWindow.end),
        Period: 900,
        Statistics: ["Sum"],
      })),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("smithy-protocol"), "rpc-v2-cbor");
  const out = decode(new Uint8Array(await response.arrayBuffer())) as {
    Datapoints: { Timestamp: Value; Sum: number }[];
  };
  assert.equal(out.Datapoints.length, 1);
  assert.equal(out.Datapoints[0].Sum, 179);
  assert.ok(out.Datapoints[0].Timestamp instanceof Date);
});

test("an unmodelled call is AccessDenied in its own protocol and recorded as denied", async () => {
  const json = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "Logs_20140328.FilterLogEvents",
      authorization: scope("logs"),
    },
    body: JSON.stringify({ logGroupName: "/aws/ecs/gp-api" }),
  });
  assert.equal(json.status, 400);
  assert.equal(((await json.json()) as { __type: string }).__type, "AccessDeniedException");

  const cbor = await fetch(
    `${endpoint}/service/GraniteServiceVersion20100801/operation/PutMetricData`,
    {
      method: "POST",
      headers: { "content-type": "application/cbor", "smithy-protocol": "rpc-v2-cbor" },
      body: new Uint8Array(encode({})),
    },
  );
  assert.equal(cbor.status, 400);
  assert.equal(
    (decode(new Uint8Array(await cbor.arrayBuffer())) as { __type: string }).__type,
    "AccessDeniedException",
  );

  const query = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "Action=DeleteAlarms&Version=2010-08-01",
  });
  assert.equal(query.status, 400);
  assert.match(await query.text(), /<Code>AccessDenied<\/Code>/);

  const state = (await (await control("/__control/state")).json()) as {
    requests: { service: string; operation: string; denied: boolean }[];
  };
  const logs = state.requests.find((r) => r.operation === "FilterLogEvents");
  assert.deepEqual(
    { service: logs?.service, denied: logs?.denied },
    { service: "logs", denied: true },
  );
  assert.ok(state.requests.some((r) => r.operation === "PutMetricData" && r.denied));
});

test("the control API requires the token and the public port never serves it", async () => {
  const bare = await fetch(`${controlUrl}/__control/state`);
  assert.equal(bare.status, 401);
  const wrong = await fetch(`${controlUrl}/__control/health`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.status, 401);
  assert.equal((await control("/__control/health")).status, 200);
  const leak = await fetch(`${endpoint}/__control/state`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(leak.status, 404);
});

test("the deploy route rolls every service to a new primary deployment", async () => {
  const bad = await control("/__control/deploy", { method: "POST", body: "{}" });
  assert.equal(bad.status, 400);
  const ok = await control("/__control/deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: "abc1234" }),
  });
  assert.equal(ok.status, 200);

  const ecs = new ECSClient({ region: "us-west-2", endpoint, credentials });
  const described = await ecs.send(
    new DescribeServicesCommand({
      cluster: "election-api",
      services: ["election-api"],
    }),
  );
  const service = described.services?.[0];
  assert.equal(service?.deployments?.length, 2);
  assert.equal(service?.deployments?.[0]?.status, "PRIMARY");
  assert.match(service?.deployments?.[0]?.taskDefinition ?? "", /election-api:42$/);
  assert.equal(service?.deployments?.[1]?.status, "INACTIVE");
  assert.match(service?.events?.[0]?.message ?? "", /steady state/);

  const state = (await (await control("/__control/state")).json()) as {
    deployments: { sha: string; service: string }[];
  };
  assert.deepEqual(state.deployments.map((d) => [d.sha, d.service]), [
    ["abc1234", "election-api"],
  ]);

  await control("/__control/reset", { method: "POST" });
  const cleared = (await (await control("/__control/state")).json()) as {
    deployments: unknown[];
    requests: unknown[];
  };
  assert.equal(cleared.deployments.length, 0);
  assert.equal(cleared.requests.length, 0);
});

test("startAwsStandin binds control only to CONTROL_HOST and reads the data file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aws-standin-"));
  const file = join(dir, "aws.json");
  writeFileSync(file, JSON.stringify(DATA));
  const { publicServer: pub, controlServer: ctl } = startAwsStandin({
    AWS_DATA_FILE: file,
    ALERT_AT: String(ALERT_AT),
    PORT: "0",
    CONTROL_PORT: "0",
    CONTROL_HOST: "127.0.0.1",
  });
  await new Promise((resolve) => ctl.once("listening", resolve));
  assert.equal((ctl.address() as AddressInfo).address, "127.0.0.1");
  pub.close();
  ctl.close();
  assert.throws(
    () => startAwsStandin({ AWS_DATA_FILE: file, ALERT_AT: "x" }),
    /ALERT_AT/,
  );
  assert.throws(
    () =>
      startAwsStandin({
        AWS_DATA_FILE: file,
        ALERT_AT: String(ALERT_AT),
        TLS_CERT_FILE: "/nope",
      }),
    /TLS/,
  );
});

const exec = promisify(execFile);
const hasCli = (() => {
  try {
    execFileSync("aws", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("the aws CLI reads ECS and CloudWatch from the stand-in", { skip: !hasCli && "aws CLI not on PATH" }, async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ENDPOINT_URL: endpoint,
    AWS_ACCESS_KEY_ID: "AKIASIMFAKE",
    AWS_SECRET_ACCESS_KEY: "fake",
    AWS_REGION: "us-west-2",
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  };
  delete env.AWS_PROFILE;
  delete env.AWS_SESSION_TOKEN;
  const clusters = await exec("aws", ["ecs", "list-clusters", "--output", "json"], { env });
  assert.match(clusters.stdout, /cluster\/election-api/);
  const stats = await exec(
    "aws",
    [
      "cloudwatch",
      "get-metric-statistics",
      "--namespace",
      "AWS/RDS",
      "--metric-name",
      "DatabaseConnections",
      "--dimensions",
      "Name=DBClusterIdentifier,Value=election-api-db-prod",
      "--start-time",
      new Date(statsWindow.start).toISOString(),
      "--end-time",
      new Date(statsWindow.end).toISOString(),
      "--period",
      "900",
      "--statistics",
      "Maximum",
      "--output",
      "json",
    ],
    { env },
  );
  const parsed = JSON.parse(stats.stdout) as { Datapoints: { Maximum: number }[] };
  assert.deepEqual(parsed.Datapoints.map((d) => d.Maximum), [99]);
});
