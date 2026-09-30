import { createServer } from "node:http";
import { appendFileSync, createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * A read-through cache for exactly one upstream: Prisma's engine binaries.
 * omni is on Prisma 6, which downloads engines during `npm ci` and `prisma
 * generate`, and the sim has no route to binaries.prisma.sh. Agents and the
 * checker reach it through PRISMA_ENGINES_MIRROR.
 *
 * It is one of the sim's three exits, with the npm proxy and the model proxy,
 * which is why it takes no host from the request: GET only, a fixed upstream,
 * and a path that cannot climb out of it.
 */

export const safePath = (url: string): string | null => {
  const path = url.split("?")[0];
  if (!path.startsWith("/") || path.includes("..") || path.includes("//")) return null;
  return path;
};

export const createMirror = (options: {
  upstream: string;
  cacheDir: string;
  log: (entry: Record<string, string | number | boolean>) => void;
  fetchImpl?: typeof fetch;
}) => {
  const fetchImpl = options.fetchImpl ?? fetch;
  mkdirSync(options.cacheDir, { recursive: true });
  return createServer((req, res) => {
    const path = safePath(req.url ?? "");
    if (req.method !== "GET" || !path) {
      options.log({ at: Date.now(), refused: true, method: req.method ?? "", url: req.url ?? "" });
      res.writeHead(405);
      res.end();
      return;
    }
    const file = join(options.cacheDir, createHash("sha256").update(path).digest("hex"));
    if (existsSync(file)) {
      options.log({ at: Date.now(), path, cached: true });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      createReadStream(file).pipe(res);
      return;
    }
    void (async () => {
      const upstream = await fetchImpl(`${options.upstream}${path}`);
      options.log({ at: Date.now(), path, cached: false, status: upstream.status });
      if (!upstream.ok) {
        res.writeHead(upstream.status);
        res.end();
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      writeFileSync(`${file}.part`, body);
      renameSync(`${file}.part`, file);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
    })().catch((error: Error) => {
      options.log({ at: Date.now(), path, error: error.message });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
};

if (require.main === module) {
  const upstream = process.env.MIRROR_UPSTREAM ?? "https://binaries.prisma.sh";
  const logFile = process.env.MIRROR_LOG ?? "/results/mirror.jsonl";
  const port = Number(process.env.PORT ?? 4874);
  createMirror({
    upstream,
    cacheDir: process.env.MIRROR_CACHE_DIR ?? "/cache",
    log: (entry) => appendFileSync(logFile, `${JSON.stringify(entry)}\n`),
  }).listen(port, "0.0.0.0", () =>
    console.log(JSON.stringify({ event: "mirror_listening", port, upstream })),
  );
}
