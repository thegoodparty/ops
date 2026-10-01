import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "GitHub",
  GIT_AUTHOR_EMAIL: "noreply@github.com",
  GIT_COMMITTER_NAME: "GitHub",
  GIT_COMMITTER_EMAIL: "noreply@github.com",
};

export const git = (dir: string, args: string[]): string =>
  execFileSync("git", args, { cwd: dir, env: ENV, encoding: "utf8", maxBuffer: 1 << 28 }).trim();

/** Exit status and output, for the git commands whose failure is an answer. */
export const gitStatus = (dir: string, args: string[]): { code: number; out: string } => {
  try {
    return { code: 0, out: git(dir, args) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: String(err.stdout ?? "").trim() };
  }
};

export const resolve = (dir: string, rev: string): string | null => {
  const { code, out } = gitStatus(dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  return code === 0 ? out : null;
};

export const isAncestor = (dir: string, a: string, b: string): boolean =>
  gitStatus(dir, ["merge-base", "--is-ancestor", a, b]).code === 0;

/** The tree of merging `head` into `base`, or null when they conflict. */
export const mergeTree = (dir: string, base: string, head: string): string | null => {
  const { code, out } = gitStatus(dir, ["merge-tree", "--write-tree", base, head]);
  return code === 0 ? out.split("\n")[0] : null;
};

// The sandbox's ruleset: nothing lands on main by push and no branch takes a
// force push. Only pushes over HTTP are checked, so seeding with local git can.
const PRE_RECEIVE = `#!/bin/sh
[ -z "$FAKE_GITHUB_HTTP" ] && exit 0
zero=0000000000000000000000000000000000000000
while read old new ref; do
  if [ "$ref" = refs/heads/main ]; then
    echo "GH013: Repository rule violations found for $ref. Changes must be made through a pull request." >&2
    exit 1
  fi
  if [ "$old" != $zero ] && [ "$new" != $zero ] && ! git merge-base --is-ancestor "$old" "$new"; then
    echo "GH013: Repository rule violations found for $ref. Cannot force-push to this branch." >&2
    exit 1
  fi
done
`;

export const initBare = (dir: string): void => {
  if (existsSync(join(dir, "HEAD"))) return;
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--bare", "-b", "main"]);
  for (const [key, value] of [
    ["http.receivepack", "true"],
    ["uploadpack.allowFilter", "true"],
    ["uploadpack.allowAnySHA1InWant", "true"],
  ]) git(dir, ["config", key, value]);
  writeFileSync(join(dir, "hooks", "pre-receive"), PRE_RECEIVE);
  chmodSync(join(dir, "hooks", "pre-receive"), 0o755);
};

/** Smart HTTP through `git http-backend`, as CGI. Resolves once the response is sent. */
export const httpBackend = (projectRoot: string, pathInfo: string, req: IncomingMessage, res: ServerResponse): Promise<void> =>
  new Promise((done) => {
    const url = new URL(req.url ?? "/", "https://github.com");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...ENV,
        FAKE_GITHUB_HTTP: "1",
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
        ...(req.headers["git-protocol"] ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
      },
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (sent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).trim().toLowerCase();
        const value = line.slice(at + 1).trim();
        if (name === "status") status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
      sent = true;
    });
    child.stderr.on("data", () => undefined);
    child.on("close", () => {
      if (!sent) res.writeHead(500).write(head);
      res.end();
      done();
    });
  });

/** A throwaway CA and a server certificate it signed for github.com, api.github.com and 127.0.0.1. */
export const makeCerts = (dir: string): { ca: string; key: string; cert: string } => {
  mkdirSync(dir, { recursive: true });
  const cnf = join(dir, "openssl.cnf");
  writeFileSync(
    cnf,
    `[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[leaf]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:github.com,DNS:api.github.com,IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`,
  );
  const ssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ssl(["req", "-x509", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "30", "-subj", "/CN=BugBoss evals fake GitHub CA", "-config", cnf, "-extensions", "ca"]);
  ssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "server.csr", "-subj", "/CN=github.com", "-config", cnf]);
  ssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", `0x${randomBytes(8).toString("hex")}`, "-out", "cert.pem", "-days", "30", "-extfile", cnf, "-extensions", "leaf"]);
  return { ca: join(dir, "ca.pem"), key: join(dir, "key.pem"), cert: join(dir, "cert.pem") };
};
