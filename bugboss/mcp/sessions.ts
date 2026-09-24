// Reading an agent's session out of S3.
//
// The harness writes its session to local disk and a wrapper PUTs the whole
// file per turn, so S3 holds a copy that is at most one turn behind. That is
// what "what is this agent doing" reads.
//
// Design spec: docs/bugboss/design.md, "Session persistence".

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

export interface AgentSession {
  incidentId: string;
  /** The S3 key the content came from. */
  key: string;
  updatedAt: number | null;
  sizeBytes: number;
  content: string;
}

export interface SessionStore {
  read(incidentId: string): Promise<AgentSession | null>;
}

export const createS3SessionStore = (args: {
  bucket: string;
  prefix?: string;
  s3?: S3Client;
}): SessionStore => {
  const s3 = args.s3 ?? new S3Client({});
  const prefix = args.prefix ?? "sessions/incident";

  return {
    read: async (incidentId) => {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: args.bucket,
          Prefix: `${prefix}/${incidentId}/`,
        }),
      );

      const objects = (listed.Contents ?? []).filter((o) => o.Key);
      if (objects.length === 0) return null;

      // A prefix rather than a single key, so take whichever object the
      // harness wrote most recently.
      const latest = objects.reduce((newest, candidate) =>
        (candidate.LastModified?.getTime() ?? 0) >
        (newest.LastModified?.getTime() ?? 0)
          ? candidate
          : newest,
      );

      const res = await s3.send(
        new GetObjectCommand({ Bucket: args.bucket, Key: latest.Key! }),
      );
      const content = (await res.Body?.transformToString()) ?? "";

      return {
        incidentId,
        key: latest.Key!,
        updatedAt: latest.LastModified?.getTime() ?? null,
        sizeBytes: latest.Size ?? content.length,
        content,
      };
    },
  };
};
