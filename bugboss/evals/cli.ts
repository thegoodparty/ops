import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { renderReport } from "./report";
import { parseTranscript, readTranscript, type Transcript } from "./transcript";

const USAGE = `Usage: npx tsx bugboss/evals/cli.ts [--out report.md] [--focus 2,3,5] <source>...

A source is a session.jsonl file, a directory of them, an incident id read
from s3://bugboss-prod/sessions/incident/<id>/session.jsonl (s3:83), or a
full s3:// URL. Transcripts are read, never written or copied anywhere.
If the SDK rejects an SSO token the aws CLI accepts, run
eval "$(aws configure export-credentials --format env)" first.`;

const DEFAULT_BUCKET = "bugboss-prod";

const fromS3 = async (client: S3Client, source: string): Promise<Transcript> => {
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
  return parseTranscript(id, body);
};

const fromPath = async (path: string): Promise<Transcript[]> => {
  if ((await stat(path)).isDirectory()) {
    const names = (await readdir(path)).filter((name) => name.endsWith(".jsonl"));
    return Promise.all(names.map((name) => readTranscript(join(path, name))));
  }
  return [await readTranscript(path)];
};

const byId = (a: Transcript, b: Transcript) => {
  const [x, y] = [Number(a.id), Number(b.id)];
  return Number.isNaN(x) || Number.isNaN(y) ? a.id.localeCompare(b.id) : x - y;
};

export const main = async (argv: string[]): Promise<number> => {
  let out: string | null = null;
  let focus: string[] = [];
  const sources: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--focus") focus = argv[++i].split(",");
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
