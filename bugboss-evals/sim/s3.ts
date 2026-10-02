import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, relative } from "node:path";

/**
 * Just enough S3 for BugBoss: its database snapshot and its agents' session
 * files. Objects land on disk under `root/<bucket>/<key>`, which is where the
 * harness reads the session transcripts from afterwards. Signatures are not
 * checked: nothing but the run's own BugBoss can reach a loopback port.
 *
 * Path-style only, which is what the SDK uses for an IP endpoint.
 */
export const startS3 = async (root: string): Promise<{ url: string; server: Server }> => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://s3");
    const [, bucket, ...rest] = url.pathname.split("/").map(decodeURIComponent);
    const key = rest.join("/");
    const path = join(root, bucket ?? "", key);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        if (req.method === "PUT") {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, Buffer.concat(chunks));
          res.writeHead(200, { etag: '"0"' }).end();
        } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const bucketDir = join(root, bucket ?? "");
          const walk = (dir: string): string[] => {
            try {
              return readdirSync(dir).flatMap((name) => {
                const full = join(dir, name);
                return statSync(full).isDirectory() ? walk(full) : [relative(bucketDir, full)];
              });
            } catch {
              return [];
            }
          };
          const keys = walk(bucketDir).filter((k) => k.startsWith(prefix)).sort();
          res.writeHead(200, { "content-type": "application/xml" }).end(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys
              .map((k) => `<Contents><Key>${k}</Key><Size>${statSync(join(bucketDir, k)).size}</Size><LastModified>${statSync(join(bucketDir, k)).mtime.toISOString()}</LastModified></Contents>`)
              .join("")}</ListBucketResult>`,
          );
        } else if (req.method === "GET" || req.method === "HEAD") {
          const body = readFileSync(path);
          res.writeHead(200, { "content-length": body.length, "last-modified": statSync(path).mtime.toUTCString() });
          res.end(req.method === "HEAD" ? undefined : body);
        } else if (req.method === "DELETE") {
          res.writeHead(204).end();
        } else {
          res.writeHead(405).end();
        }
      } catch {
        res
          .writeHead(404, { "content-type": "application/xml" })
          .end("<Error><Code>NoSuchKey</Code><Message>not found</Message></Error>");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("s3 did not bind");
  return { url: `http://127.0.0.1:${address.port}`, server };
};
