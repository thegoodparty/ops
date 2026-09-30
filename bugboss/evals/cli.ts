import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { renderReport } from "./report";
import { parsePiSession, readPiSession } from "./adapters/pi-session";
import type { Trace } from "./trace";

const USAGE = `Usage: npx tsx bugboss/evals/cli.ts [--out report.md] [--focus 2,3,5] <source>...

A source is a session.jsonl file, a directory of them, an incident id read
from s3://bugboss-prod/sessions/incident/<id>/session.jsonl (s3:83), or a
full s3:// URL. Transcripts are read, never written or copied anywhere.
If the SDK rejects an SSO token the aws CLI accepts, run
eval "$(aws configure export-credentials --format env)" first.`;

const DEFAULT_BUCKET = "bugboss-prod";

const fromS3 = async (client: S3Client, source: string): Promise<Trace> => {
  const url = source.startsWith("s3://")
    ? source
    : `s3://${DEFAULT_BUCKET}/sessions/incident/${source.slice(3)}/session.jsonl`;
  const [, , bucket, ...key] = url.split("/");
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key.join("/") }),
  );
  const body = await response.Body?.transformToString("utf8");
  if (body === undefined) throw new Error(`empty object: ${url}`);
  const id = source.startsWith("s3:") && !source.startsWith("s3://")
    ? source.slice(3)
    : key[key.length - 2] ?? url;
  return parsePiSession(id, body);
};

const fromPath = async (path: string): Promise<Trace[]> => {
  if ((await stat(path)).isDirectory()) {
    const names = (await readdir(path)).filter((name) => name.endsWith(".jsonl"));
    return Promise.all(names.map((name) => readPiSession(join(path, name))));
  }
  return [await readPiSession(path)];
};

const byId = (a: Trace, b: Trace) => {
  const [x, y] = [Number(a.id), Number(b.id)];
  return Number.isNaN(x) || Number.isNaN(y) ? a.id.localeCompare(b.id) : x - y;
};

class UsageError extends Error {}

export const main = async (argv: string[]): Promise<number> => {
  try {
    return await run(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
};

const run = async (argv: string[]): Promise<number> => {
  let out: string | null = null;
  let focus: string[] = [];
  const sources: string[] = [];
  const valueOf = (flag: string, value: string | undefined) => {
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = valueOf("--out", argv[++i]);
    else if (argv[i] === "--focus") focus = valueOf("--focus", argv[++i]).split(",");
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(USAGE);
      return 0;
    } else sources.push(argv[i]);
  }
  if (sources.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const client = sources.some((s) => s.startsWith("s3:"))
    ? new S3Client({ region: process.env.AWS_REGION ?? "us-west-2" })
    : null;
  const transcripts = (
    await Promise.all(
      sources.map(async (source) =>
        source.startsWith("s3:") && client
          ? [await fromS3(client, source)]
          : fromPath(source),
      ),
    )
  )
    .flat()
    .sort(byId);
  if (transcripts.length === 0) {
    throw new UsageError(`no .jsonl transcripts found in ${sources.join(", ")}`);
  }
  const report = renderReport(transcripts, { focus });
  if (out) {
    await writeFile(out, report);
    console.error(`wrote ${out}`);
  } else {
    console.log(report);
  }
  return 0;
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
