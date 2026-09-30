import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";

import type { AwsData, MetricDatapoint } from "../aws-data";
import { decode as decodeCbor, encode as encodeCbor, type Value } from "./cbor";

const ACCOUNT_ID = "123456789012";
const DEFAULT_REGION = "us-west-2";
const CLOUDWATCH_XMLNS = "http://monitoring.amazonaws.com/doc/2010-08-01/";

type Protocol = "json" | "query" | "cbor" | "rest";
type Obj = { [key: string]: Value };

export interface AwsRequestRecord {
  at: number;
  service: string;
  operation: string;
  protocol: Protocol;
  denied: boolean;
}

export interface AwsDeploymentRecord {
  at: number;
  sha: string;
  cluster: string;
  service: string;
}

export interface AwsStandinState {
  requests: AwsRequestRecord[];
  deployments: AwsDeploymentRecord[];
}

export interface AwsStandin {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  handleControl: (req: IncomingMessage, res: ServerResponse) => void;
  state: () => AwsStandinState;
}

class AwsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const denied = (service: string, operation: string): AwsError =>
  new AwsError(
    "AccessDeniedException",
    `User: arn:aws:iam::${ACCOUNT_ID}:user/bugboss-sim is not authorized to perform: ${service}:${operation}`,
  );

const isObj = (value: Value): value is Obj =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

const obj = (value: Value): Obj => (isObj(value) ? value : {});
const list = (value: Value): Value[] => (Array.isArray(value) ? value : []);
const text = (value: Value): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;
const strings = (value: Value): string[] =>
  list(value).flatMap((item) => {
    const s = text(item);
    return s === undefined ? [] : [s];
  });

const toMs = (value: Value): number | undefined => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value * 1000;
  if (typeof value === "string") {
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

// W5 writes aws.json by hand, so its datapoints cannot carry real epochs: a
// |ts| below 1e11 is milliseconds relative to the alert (negative is before
// it), anything larger is an absolute epoch in ms.
export const datapointMs = (point: MetricDatapoint, alertAt: number): number =>
  Math.abs(point.ts) < 1e11 ? alertAt + point.ts : point.ts;

const lastSegment = (ref: string): string => ref.split("/").pop() ?? ref;

const parseTaskDefinition = (
  ref: string,
): { family: string; revision: number } => {
  const tail = lastSegment(ref);
  const match = /^(.*):(\d+)$/.exec(tail);
  return match
    ? { family: match[1], revision: Number(match[2]) }
    : { family: tail, revision: 1 };
};

interface Deployment {
  id: string;
  status: "PRIMARY" | "ACTIVE" | "INACTIVE";
  taskDefinition: string;
  desiredCount: number;
  runningCount: number;
  createdAt: number;
  updatedAt: number;
}

interface ServiceEvent {
  id: string;
  createdAt: number;
  message: string;
}

interface ServiceState {
  cluster: string;
  name: string;
  desiredCount: number;
  runningCount: number;
  family: string;
  revision: number;
  deployments: Deployment[];
  events: ServiceEvent[];
}

const deploymentId = (): string =>
  `ecs-svc/${Array.from({ length: 19 }, () => Math.floor(Math.random() * 10)).join("")}`;

// ---------------------------------------------------------------------------
// Query protocol: flattened form fields to a nested structure
// ---------------------------------------------------------------------------

const parseQuery = (body: string): Obj => {
  const root: Obj = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const path: (string | number)[] = [];
    const parts = key.split(".");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "member" && /^\d+$/.test(parts[i + 1] ?? "")) {
        path.push(Number(parts[i + 1]) - 1);
        i++;
      } else {
        path.push(parts[i]);
      }
    }
    let cursor: Obj | Value[] = root;
    path.forEach((step, i) => {
      const last = i === path.length - 1;
      const nextIsIndex = typeof path[i + 1] === "number";
      const current: Value = Array.isArray(cursor)
        ? cursor[step as number]
        : cursor[step as string];
      let next: Value;
      if (last) next = value;
      else if (nextIsIndex) next = Array.isArray(current) ? current : [];
      else next = isObj(current) ? current : {};
      if (Array.isArray(cursor)) cursor[step as number] = next;
      else cursor[step as string] = next;
      if (!last) cursor = next as Obj | Value[];
    });
  }
  return root;
};

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const toXml = (value: Value): string => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => `<member>${toXml(item)}</member>`).join("");
  }
  if (isObj(value)) {
    return Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<${k}>${toXml(v)}</${k}>`)
      .join("");
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return escapeXml(String(value));
};

// ---------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------

const TARGET_SERVICES: Record<string, string> = {
  AmazonEC2ContainerServiceV20141113: "ecs",
  GraniteServiceVersion20100801: "monitoring",
  secretsmanager: "secretsmanager",
  Logs_20140328: "logs",
  AmazonSSM: "ssm",
  AWSSecurityTokenServiceV20110615: "sts",
};

const scopeService = (
  authorization: string | undefined,
): { region: string; service: string } | undefined => {
  const match =
    /Credential=[^/]+\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/.exec(
      authorization ?? "",
    );
  return match ? { region: match[1], service: match[2] } : undefined;
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export const createAwsStandin = (options: {
  data: AwsData;
  alertAt: number;
  now?: () => number;
  controlToken?: string;
}): AwsStandin => {
  const { data, alertAt } = options;
  const now = options.now ?? Date.now;

  let requests: AwsRequestRecord[] = [];
  let deployments: AwsDeploymentRecord[] = [];
  let services: ServiceState[] = [];

  const reset = (): void => {
    requests = [];
    deployments = [];
    const bootAt = alertAt - 86_400_000;
    services = data.ecs.services.map((svc) => {
      const { family, revision } = parseTaskDefinition(svc.taskDefinition);
      return {
        cluster: lastSegment(svc.cluster),
        name: svc.name,
        desiredCount: svc.desiredCount,
        runningCount: svc.runningCount,
        family,
        revision,
        deployments: [
          {
            id: deploymentId(),
            status: "PRIMARY",
            taskDefinition: `${family}:${revision}`,
            desiredCount: svc.desiredCount,
            runningCount: svc.runningCount,
            createdAt: bootAt,
            updatedAt: bootAt,
          },
        ],
        events: [
          {
            id: randomUUID(),
            createdAt: bootAt,
            message: `(service ${svc.name}) has reached a steady state.`,
          },
        ],
      };
    });
  };
  reset();

  // ---- ECS ----------------------------------------------------------------

  const arn = (region: string, kind: string, path: string): string =>
    `arn:aws:ecs:${region}:${ACCOUNT_ID}:${kind}/${path}`;

  const clusterNames = (): string[] => [
    ...new Set([
      ...data.ecs.clusters.map(lastSegment),
      ...services.map((s) => s.cluster),
    ]),
  ];

  const renderService = (svc: ServiceState, region: string, ts: TsOut): Obj => ({
    serviceArn: arn(region, "service", `${svc.cluster}/${svc.name}`),
    serviceName: svc.name,
    clusterArn: arn(region, "cluster", svc.cluster),
    status: "ACTIVE",
    desiredCount: svc.desiredCount,
    runningCount: svc.runningCount,
    pendingCount: 0,
    launchType: "FARGATE",
    taskDefinition: arn(
      region,
      "task-definition",
      `${svc.family}:${svc.revision}`,
    ),
    deployments: svc.deployments.map((d) => ({
      id: d.id,
      status: d.status,
      taskDefinition: arn(region, "task-definition", d.taskDefinition),
      desiredCount: d.desiredCount,
      runningCount: d.runningCount,
      pendingCount: 0,
      failedTasks: 0,
      launchType: "FARGATE",
      createdAt: ts(d.createdAt),
      updatedAt: ts(d.updatedAt),
      rolloutState: "COMPLETED",
      rolloutStateReason: "ECS deployment completed.",
    })),
    events: [...svc.events]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => ({ id: e.id, createdAt: ts(e.createdAt), message: e.message })),
    createdAt: ts(svc.deployments[0]?.createdAt ?? alertAt),
  });

  const ecs = (operation: string, input: Obj, region: string): Obj => {
    const ts: TsOut = (ms) => ms / 1000;
    const clusterOf = (value: Value): string =>
      lastSegment(text(value) ?? "default");
    switch (operation) {
      case "ListClusters":
        return {
          clusterArns: clusterNames().map((c) => arn(region, "cluster", c)),
        };
      case "DescribeClusters": {
        const wanted = strings(input.clusters).map(lastSegment);
        const names = wanted.length ? wanted : ["default"];
        const known = clusterNames();
        return {
          clusters: names
            .filter((n) => known.includes(n))
            .map((n) => ({
              clusterArn: arn(region, "cluster", n),
              clusterName: n,
              status: "ACTIVE",
              activeServicesCount: services.filter((s) => s.cluster === n)
                .length,
              runningTasksCount: services
                .filter((s) => s.cluster === n)
                .reduce((sum, s) => sum + s.runningCount, 0),
              pendingTasksCount: 0,
              registeredContainerInstancesCount: 0,
            })),
          failures: names
            .filter((n) => !known.includes(n))
            .map((n) => ({ arn: arn(region, "cluster", n), reason: "MISSING" })),
        };
      }
      case "ListServices": {
        const cluster = clusterOf(input.cluster);
        return {
          serviceArns: services
            .filter((s) => s.cluster === cluster)
            .map((s) => arn(region, "service", `${s.cluster}/${s.name}`)),
        };
      }
      case "DescribeServices": {
        const cluster = clusterOf(input.cluster);
        const wanted = strings(input.services).map(lastSegment);
        const found = wanted.flatMap((name) => {
          const svc = services.find(
            (s) => s.cluster === cluster && s.name === name,
          );
          return svc ? [svc] : [];
        });
        return {
          services: found.map((svc) => renderService(svc, region, ts)),
          failures: wanted
            .filter((name) => !found.some((s) => s.name === name))
            .map((name) => ({
              arn: arn(region, "service", `${cluster}/${name}`),
              reason: "MISSING",
            })),
        };
      }
      case "ListTasks":
        return { taskArns: [] };
      case "DescribeTasks":
        return { tasks: [], failures: [] };
      case "ListTaskDefinitions": {
        const prefix = text(input.familyPrefix);
        return {
          taskDefinitionArns: services
            .filter((s) => !prefix || s.family.startsWith(prefix))
            .flatMap((s) =>
              s.deployments.map((d) =>
                arn(region, "task-definition", d.taskDefinition),
              ),
            ),
        };
      }
      case "DescribeTaskDefinition": {
        const { family, revision } = parseTaskDefinition(
          text(input.taskDefinition) ?? "",
        );
        const svc = services.find((s) => s.family === family);
        if (!svc) {
          throw new AwsError(
            "ClientException",
            "Unable to describe task definition.",
          );
        }
        const rev = /:\d+$/.test(text(input.taskDefinition) ?? "")
          ? revision
          : svc.revision;
        return {
          taskDefinition: {
            taskDefinitionArn: arn(
              region,
              "task-definition",
              `${family}:${rev}`,
            ),
            family,
            revision: rev,
            status: "ACTIVE",
            networkMode: "awsvpc",
            requiresCompatibilities: ["FARGATE"],
            containerDefinitions: [
              { name: svc.name, image: `${svc.name}:${rev}`, essential: true },
            ],
          },
        };
      }
      default:
        throw denied("ecs", operation);
    }
  };

  // ---- CloudWatch ---------------------------------------------------------

  type Dim = { Name: string; Value: string };

  const dimsOf = (value: Value): Dim[] =>
    list(value).flatMap((item) => {
      const d = obj(item);
      const name = text(d.Name);
      return name === undefined ? [] : [{ Name: name, Value: text(d.Value) ?? "" }];
    });

  const metricDims = (dims: Record<string, string>): Dim[] =>
    Object.entries(dims).map(([Name, Value]) => ({ Name, Value }));

  const sameDims = (metric: Record<string, string>, requested: Dim[]): boolean => {
    const keys = Object.keys(metric);
    return (
      keys.length === requested.length &&
      requested.every((d) => metric[d.Name] === d.Value)
    );
  };

  const findMetric = (spec: Obj) => {
    const namespace = text(spec.Namespace);
    const metricName = text(spec.MetricName);
    const dims = dimsOf(spec.Dimensions);
    return data.cloudwatch.find(
      (m) =>
        m.namespace === namespace &&
        m.metricName === metricName &&
        sameDims(m.dimensions, dims),
    );
  };

  const percentile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
  };

  const statistic = (values: number[], stat: string): number | undefined => {
    if (values.length === 0) return undefined;
    switch (stat) {
      case "SampleCount":
        return values.length;
      case "Sum":
        return values.reduce((a, b) => a + b, 0);
      case "Average":
        return values.reduce((a, b) => a + b, 0) / values.length;
      case "Minimum":
        return Math.min(...values);
      case "Maximum":
        return Math.max(...values);
      default: {
        const match = /^p(\d+(\.\d+)?)$/.exec(stat);
        return match ? percentile(values, Number(match[1])) : undefined;
      }
    }
  };

  const buckets = (
    metric: AwsData["cloudwatch"][number],
    startMs: number,
    endMs: number,
    periodSeconds: number,
  ): Map<number, number[]> => {
    const periodMs = Math.max(1, periodSeconds) * 1000;
    const out = new Map<number, number[]>();
    for (const point of metric.datapoints) {
      const at = datapointMs(point, alertAt);
      if (at < startMs || at >= endMs) continue;
      const bucket = Math.floor(at / periodMs) * periodMs;
      out.set(bucket, [...(out.get(bucket) ?? []), point.value]);
    }
    return out;
  };

  const cloudwatch = (
    operation: string,
    input: Obj,
    ts: TsOut,
  ): Obj => {
    switch (operation) {
      case "ListMetrics": {
        const namespace = text(input.Namespace);
        const metricName = text(input.MetricName);
        const filters = dimsOf(input.Dimensions);
        const rawFilters = list(input.Dimensions).map(obj);
        return {
          Metrics: data.cloudwatch
            .filter(
              (m) =>
                (!namespace || m.namespace === namespace) &&
                (!metricName || m.metricName === metricName) &&
                filters.every((f, i) =>
                  rawFilters[i]?.Value === undefined
                    ? f.Name in m.dimensions
                    : m.dimensions[f.Name] === f.Value,
                ),
            )
            .map((m) => ({
              Namespace: m.namespace,
              MetricName: m.metricName,
              Dimensions: metricDims(m.dimensions),
            })),
        };
      }
      case "GetMetricStatistics": {
        const startMs = toMs(input.StartTime);
        const endMs = toMs(input.EndTime);
        const period = Number(text(input.Period) ?? 60);
        if (startMs === undefined || endMs === undefined) {
          throw new AwsError(
            "InvalidParameterCombination",
            "StartTime and EndTime are required",
          );
        }
        const stats = strings(input.Statistics);
        const extended = strings(input.ExtendedStatistics);
        const metric = findMetric(input);
        const unit = text(input.Unit);
        const label = text(input.MetricName) ?? "";
        if (!metric || (unit && unit !== metric.unit)) {
          return { Label: label, Datapoints: [] };
        }
        const points = [...buckets(metric, startMs, endMs, period).entries()]
          .sort(([a], [b]) => a - b)
          .map(([bucket, values]) => {
            const point: Obj = { Timestamp: ts(bucket) };
            for (const stat of stats) {
              const v = statistic(values, stat);
              if (v !== undefined) point[stat] = v;
            }
            if (extended.length) {
              const ext: Obj = {};
              for (const stat of extended) {
                const v = statistic(values, stat);
                if (v !== undefined) ext[stat] = v;
              }
              point.ExtendedStatistics = ext;
            }
            point.Unit = metric.unit;
            return point;
          });
        return { Label: label, Datapoints: points };
      }
      case "GetMetricData": {
        const startMs = toMs(input.StartTime);
        const endMs = toMs(input.EndTime);
        if (startMs === undefined || endMs === undefined) {
          throw new AwsError(
            "InvalidParameterCombination",
            "StartTime and EndTime are required",
          );
        }
        const ascending = text(input.ScanBy) === "TimestampAscending";
        const messages: Obj[] = [];
        const results = list(input.MetricDataQueries)
          .map(obj)
          .filter((q) => text(q.ReturnData) !== "false" && q.ReturnData !== false)
          .map((query) => {
            const id = text(query.Id) ?? "";
            const stat = obj(query.MetricStat);
            if (!isObj(query.MetricStat)) {
              messages.push({
                Code: "Unsupported",
                Value: `query ${id}: only MetricStat queries are modelled`,
              });
              return {
                Id: id,
                Label: text(query.Label) ?? id,
                Timestamps: [],
                Values: [],
                StatusCode: "Complete",
              };
            }
            const metricSpec = obj(stat.Metric);
            const metric = findMetric(metricSpec);
            const statName = text(stat.Stat) ?? "Average";
            const period = Number(text(stat.Period) ?? 60);
            const rows = metric
              ? [...buckets(metric, startMs, endMs, period).entries()]
                  .map(([bucket, values]) => ({
                    bucket,
                    value: statistic(values, statName),
                  }))
                  .filter(
                    (r): r is { bucket: number; value: number } =>
                      r.value !== undefined,
                  )
                  .sort((a, b) =>
                    ascending ? a.bucket - b.bucket : b.bucket - a.bucket,
                  )
              : [];
            return {
              Id: id,
              Label: text(query.Label) ?? text(metricSpec.MetricName) ?? id,
              Timestamps: rows.map((r) => ts(r.bucket)),
              Values: rows.map((r) => r.value),
              StatusCode: "Complete",
            };
          });
        return { MetricDataResults: results, Messages: messages };
      }
      default:
        throw denied("cloudwatch", operation);
    }
  };

  // ---- Secrets Manager ----------------------------------------------------

  const secretArn = (region: string, name: string): string =>
    `arn:aws:secretsmanager:${region}:${ACCOUNT_ID}:secret:${name}-AbCdEf`;

  const secretsmanager = (
    operation: string,
    input: Obj,
    region: string,
  ): Obj => {
    const render = (name: string): Obj => ({
      ARN: secretArn(region, name),
      Name: name,
      LastChangedDate: (alertAt - 30 * 86_400_000) / 1000,
    });
    switch (operation) {
      case "ListSecrets": {
        const nameFilters = list(input.Filters)
          .map(obj)
          .filter((f) => text(f.Key) === "name")
          .flatMap((f) => strings(f.Values));
        return {
          SecretList: data.secretsManager.names
            .filter(
              (n) =>
                nameFilters.length === 0 ||
                nameFilters.some((prefix) => n.startsWith(prefix)),
            )
            .map(render),
        };
      }
      case "DescribeSecret": {
        const id = text(input.SecretId) ?? "";
        const name = data.secretsManager.names.find(
          (n) => n === id || secretArn(region, n) === id,
        );
        if (!name) {
          throw new AwsError(
            "ResourceNotFoundException",
            "Secrets Manager can't find the specified secret.",
          );
        }
        return render(name);
      }
      default:
        throw denied("secretsmanager", operation);
    }
  };

  // ---- Protocol dispatch --------------------------------------------------

  type TsOut = (ms: number) => Value;

  const send = (
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: Buffer | string,
  ): void => {
    res.writeHead(status, { ...headers, "x-amzn-requestid": randomUUID() });
    res.end(body);
  };

  const handleAsync = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://aws");
    if (url.pathname.startsWith("/__control")) {
      send(res, 404, { "content-type": "text/plain" }, "not found");
      return;
    }
    const raw = await readBody(req);
    const scope = scopeService(req.headers.authorization);
    const region = scope?.region ?? DEFAULT_REGION;
    const target = req.headers["x-amz-target"];
    const contentType = String(req.headers["content-type"] ?? "");
    const cborPath = /^\/service\/([^/]+)\/operation\/([^/?]+)/.exec(
      url.pathname,
    );

    let protocol: Protocol;
    let operation: string;
    let fromTarget: string | undefined;
    let input: Obj = {};

    try {
      if (cborPath) {
        protocol = "cbor";
        fromTarget = TARGET_SERVICES[cborPath[1]];
        operation = cborPath[2];
        input = raw.length ? obj(decodeCbor(raw)) : {};
      } else if (typeof target === "string") {
        protocol = "json";
        const dot = target.lastIndexOf(".");
        fromTarget = TARGET_SERVICES[target.slice(0, dot)];
        operation = target.slice(dot + 1);
        input = raw.length ? obj(JSON.parse(raw.toString("utf8")) as Value) : {};
      } else {
        const form = contentType.includes("x-www-form-urlencoded")
          ? raw.toString("utf8")
          : url.search.slice(1);
        const parsed = parseQuery(form);
        if (typeof parsed.Action === "string") {
          protocol = "query";
          operation = parsed.Action;
          input = parsed;
          fromTarget =
            parsed.Version === "2010-08-01" ? "monitoring" : undefined;
        } else {
          protocol = "rest";
          operation = `${req.method ?? "GET"} ${url.pathname}`;
        }
      }
    } catch {
      send(
        res,
        400,
        { "content-type": "application/json" },
        JSON.stringify({
          __type: "SerializationException",
          message: "request body could not be parsed",
        }),
      );
      return;
    }

    const service = scope?.service ?? fromTarget ?? "unknown";
    const record: AwsRequestRecord = {
      at: now(),
      service,
      operation,
      protocol,
      denied: false,
    };
    requests.push(record);

    const ts: TsOut =
      protocol === "cbor"
        ? (ms) => new Date(ms)
        : protocol === "query"
          ? (ms) => new Date(ms)
          : (ms) => ms / 1000;

    try {
      let output: Obj;
      if (service === "ecs" && protocol === "json") {
        output = ecs(operation, input, region);
      } else if (service === "monitoring" && protocol !== "rest") {
        output = cloudwatch(operation, input, ts);
      } else if (service === "secretsmanager" && protocol === "json") {
        output = secretsmanager(operation, input, region);
      } else {
        throw denied(service, operation);
      }

      if (protocol === "cbor") {
        send(
          res,
          200,
          {
            "content-type": "application/cbor",
            "smithy-protocol": "rpc-v2-cbor",
          },
          encodeCbor(output),
        );
      } else if (protocol === "query") {
        const requestId = randomUUID();
        send(
          res,
          200,
          { "content-type": "text/xml" },
          `<?xml version="1.0" encoding="UTF-8"?><${operation}Response xmlns="${CLOUDWATCH_XMLNS}"><${operation}Result>${toXml(output)}</${operation}Result><ResponseMetadata><RequestId>${requestId}</RequestId></ResponseMetadata></${operation}Response>`,
        );
      } else {
        const version = contentType.includes("1.0") ? "1.0" : "1.1";
        send(
          res,
          200,
          { "content-type": `application/x-amz-json-${version}` },
          JSON.stringify(output),
        );
      }
    } catch (error) {
      const err =
        error instanceof AwsError
          ? error
          : new AwsError("InternalFailure", String(error), 500);
      if (err.code === "AccessDeniedException") record.denied = true;
      if (protocol === "cbor") {
        send(
          res,
          err.status,
          {
            "content-type": "application/cbor",
            "smithy-protocol": "rpc-v2-cbor",
          },
          encodeCbor({ __type: err.code, message: err.message }),
        );
      } else if (protocol === "query") {
        const code =
          err.code === "AccessDeniedException" ? "AccessDenied" : err.code;
        send(
          res,
          err.status,
          { "content-type": "text/xml" },
          `<?xml version="1.0" encoding="UTF-8"?><ErrorResponse xmlns="${CLOUDWATCH_XMLNS}"><Error><Type>Sender</Type><Code>${escapeXml(code)}</Code><Message>${escapeXml(err.message)}</Message></Error><RequestId>${randomUUID()}</RequestId></ErrorResponse>`,
        );
      } else {
        const headers: Record<string, string> = {
          "content-type": "application/x-amz-json-1.1",
          "x-amzn-errortype": err.code,
        };
        // CloudWatch is awsQueryCompatible: its JSON clients read the legacy
        // query code from this header rather than from __type.
        if (service === "monitoring") {
          headers["x-amzn-query-error"] = `${
            err.code === "AccessDeniedException" ? "AccessDenied" : err.code
          };Sender`;
        }
        send(
          res,
          err.status,
          headers,
          JSON.stringify({ __type: err.code, message: err.message }),
        );
      }
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    handleAsync(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end(String(error));
    });
  };

  // ---- Control ------------------------------------------------------------

  const state = (): AwsStandinState => ({
    requests: requests.map((r) => ({ ...r })),
    deployments: deployments.map((d) => ({ ...d })),
  });

  const deploy = (sha: string): void => {
    const at = now();
    for (const svc of services) {
      for (const d of svc.deployments) {
        if (d.status === "PRIMARY") {
          d.status = "INACTIVE";
          d.updatedAt = at;
        }
      }
      svc.revision += 1;
      svc.deployments.unshift({
        id: deploymentId(),
        status: "PRIMARY",
        taskDefinition: `${svc.family}:${svc.revision}`,
        desiredCount: svc.desiredCount,
        runningCount: svc.desiredCount,
        createdAt: at,
        updatedAt: at,
      });
      svc.runningCount = svc.desiredCount;
      svc.events.push(
        {
          id: randomUUID(),
          createdAt: at,
          message: `(service ${svc.name}) has started ${svc.desiredCount} tasks: (task ${randomUUID().replace(/-/g, "")}).`,
        },
        {
          id: randomUUID(),
          createdAt: at + 1,
          message: `(service ${svc.name}) has reached a steady state.`,
        },
      );
      deployments.push({ at, sha, cluster: svc.cluster, service: svc.name });
    }
  };

  const json = (res: ServerResponse, status: number, body: object): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handleControl = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://aws");
    const token = options.controlToken;
    if (!url.pathname.startsWith("/__control")) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    readBody(req).then(
      (body) => {
        switch (route) {
          case "GET /__control/health":
            json(res, 200, { ok: true });
            return;
          case "GET /__control/state":
            json(res, 200, state());
            return;
          case "POST /__control/reset":
            reset();
            json(res, 200, { ok: true });
            return;
          case "POST /__control/deploy": {
            let sha: string | undefined;
            try {
              sha = text(obj(JSON.parse(body.toString("utf8")) as Value).sha);
            } catch {
              sha = undefined;
            }
            if (!sha) {
              json(res, 400, { error: "body must be JSON with a sha" });
              return;
            }
            deploy(sha);
            json(res, 200, { ok: true, deployments: deployments.length });
            return;
          }
          default:
            json(res, 404, { error: "not found" });
        }
      },
      (error: unknown) => json(res, 500, { error: String(error) }),
    );
  };

  return { handle, handleControl, state };
};

export const startAwsStandin = (env: NodeJS.ProcessEnv = process.env) => {
  const dataFile = env.AWS_DATA_FILE;
  if (!dataFile) throw new Error("AWS_DATA_FILE is required");
  const alertAt = Number(env.ALERT_AT);
  if (!Number.isFinite(alertAt)) throw new Error("ALERT_AT must be epoch ms");
  const certFile = env.TLS_CERT_FILE;
  const keyFile = env.TLS_KEY_FILE;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error("set both TLS_CERT_FILE and TLS_KEY_FILE, or neither");
  }

  const data = JSON.parse(readFileSync(dataFile, "utf8")) as AwsData;
  const standin = createAwsStandin({
    data,
    alertAt,
    controlToken: env.CONTROL_TOKEN || undefined,
  });

  const serve = (
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server =>
    certFile && keyFile
      ? createHttpsServer(
          { cert: readFileSync(certFile), key: readFileSync(keyFile) },
          handler,
        )
      : createHttpServer(handler);

  const port = Number(env.PORT ?? 8446);
  const controlPort = Number(env.CONTROL_PORT ?? 9004);
  const controlHost = env.CONTROL_HOST ?? "0.0.0.0";

  const publicServer = serve(standin.handle).listen(port, "0.0.0.0");
  const controlServer = createHttpServer(standin.handleControl).listen(
    controlPort,
    controlHost,
  );
  return { standin, publicServer, controlServer };
};

if (require.main === module) {
  const { publicServer, controlServer } = startAwsStandin();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      publicServer.close();
      controlServer.close();
      process.exit(0);
    });
  }
}
