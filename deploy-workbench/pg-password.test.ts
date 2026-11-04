import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BIFROST_PG_PASSWORD_SCRIPT_PATH } from "./pg-password-image";

/**
 * The password command, run as the container runs it: a real process, spawned
 * without a shell, printing the password on stdout (step 6 of
 * `docs/bifrost-zero-downtime-deploys.md`, decision 20).
 *
 * There is no AWS CLI here, so the test puts a stub `aws` first on `PATH` that
 * behaves like `secretsmanager get-secret-value` where the script can see it:
 * it prints the secret's `SecretString` and exits 0, or fails the way the CLI
 * fails. Real `jq` does the parsing, so the extraction itself is exercised
 * rather than mocked.
 *
 * What this pins is the part that would fail silently: the value on stdout is
 * the password and nothing else (Bifrost trims the trailing newline), an error
 * is a non-zero exit with a message on stderr (Bifrost surfaces stderr in the
 * dial error and caches nothing, so the next connection retries), and the value
 * never appears on stderr.
 */

const SECRET_JSON = JSON.stringify({
  username: "dbadmin",
  password: "wS3cret-Pa55word!",
  engine: "postgres",
  host: "bifrost-db.example",
  port: 5432,
  dbInstanceIdentifier: "bifrost-db",
});

type Result = { status: number | null; stdout: string; stderr: string };

/**
 * Runs the script with a stub `aws` on PATH. `behaviour` is the shell body the
 * stub executes, so a test can make it succeed, fail, or print something the
 * script has to refuse.
 */
const runCommand = (args: {
  behaviour: string;
  env?: Record<string, string>;
}): Promise<Result> => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pg-password-bin-"));
  const stub = path.join(bin, "aws");
  fs.writeFileSync(stub, `#!/bin/sh\n${args.behaviour}\n`, { mode: 0o755 });

  return new Promise((resolve, reject) => {
    // spawn, not spawnSync: this event loop is not needed by the child, but the
    // cleanup below must run whatever happens.
    const child = spawn(BIFROST_PG_PASSWORD_SCRIPT_PATH, [], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PG_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:024901689212:secret:rds!db-abc",
        ...args.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      fs.rmSync(bin, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
};

/** A stub that answers with `payload` on stdout and exits 0. */
const succeedsWith = (payload: string): string =>
  `printf '%s' '${payload}'\n`;

describe("the database password command", () => {
  it("prints the password and nothing else", async () => {
    const result = await runCommand({
      behaviour: succeedsWith(SECRET_JSON),
    });
    assert.equal(result.status, 0, result.stderr);
    // A single trailing newline, which is what a CLI prints and what Bifrost
    // trims (`strings.TrimRight(stdout, "\r\n")` in `RunPasswordCommand`).
    // Nothing else is on stdout: no banner, no ARN, no JSON.
    assert.equal(result.stdout, "wS3cret-Pa55word!\n");
    assert.equal(result.stderr, "");
  });

  it("asks for the current version of the one secret it was given", async () => {
    // The command is assembled from `PG_SECRET_ARN`, and the version stage is
    // `AWSCURRENT`: RDS writes a rotated password there, in the same secret, so
    // nothing has to look at the version list.
    const result = await runCommand({
      behaviour: `printf '%s\\n' "$@" >&2\n${succeedsWith(SECRET_JSON)}`,
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = result.stderr.trim().split("\n");
    assert.deepEqual(argv, [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      "arn:aws:secretsmanager:us-west-2:024901689212:secret:rds!db-abc",
      "--version-stage",
      "AWSCURRENT",
      "--query",
      "SecretString",
      "--output",
      "text",
    ]);
  });

  it("fails with the CLI's own message rather than printing nothing", async () => {
    // A dial that carries on with an empty password is the silent failure this
    // whole step exists to remove: Bifrost never caches a failed resolution, so
    // the message is what an operator reads on the first connection after a
    // broken credential, and a retry is the next connection.
    const result = await runCommand({
      behaviour:
        "echo 'An error occurred (AccessDeniedException) when calling the GetSecretValue operation' >&2\nexit 254",
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /GetSecretValue failed/,
      "the error must name the call that failed",
    );
    assert.match(result.stderr, /AccessDeniedException/);
    // The ARN is not a credential, so naming it is a help rather than a leak.
    assert.match(result.stderr, /rds!db-abc/);
  });

  it("refuses a secret with no password key instead of printing an empty line", async () => {
    const result = await runCommand({
      behaviour: succeedsWith(JSON.stringify({ username: "dbadmin" })),
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /no non-empty password key/);
  });

  it("refuses an empty password rather than authenticating with nothing", async () => {
    const result = await runCommand({
      behaviour: succeedsWith(JSON.stringify({ password: "" })),
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /no non-empty password key/);
  });

  it("refuses to run at all without the secret's ARN", async () => {
    // The ARN is the one thing that cannot come from anywhere else: the schema's
    // `args` are literal strings, so a missing environment variable is a
    // misconfigured task definition rather than something to search for.
    const result = await runCommand({
      behaviour: succeedsWith(SECRET_JSON),
      env: { PG_SECRET_ARN: "" },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /PG_SECRET_ARN/);
  });

  it("never writes the value to stderr", async () => {
    // The value reaches stdout, which is where Bifrost reads it. One log line
    // would put the master password in CloudWatch, which is not a secret store.
    const result = await runCommand({
      behaviour: succeedsWith(SECRET_JSON),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      !result.stderr.includes("wS3cret-Pa55word!"),
      "the password must not appear on stderr",
    );
  });

  it("disables the metadata fallback so a missing credential fails fast", async () => {
    // A Fargate task has no IMDS. Without this the CLI probes it, waits, and
    // fails with a message about the metadata service rather than about the
    // missing task role.
    const result = await runCommand({
      behaviour: `printf '%s\\n' "disabled=\${AWS_EC2_METADATA_DISABLED:-unset}" >&2\n${succeedsWith(SECRET_JSON)}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /disabled=true/);
  });
});

describe("the command's dependence on Bifrost's environment inheritance", () => {
  /**
   * The command reads `PG_SECRET_ARN` and the task role's container
   * credentials from its own environment. That only works because Bifrost runs
   * it with `cmd.Env` left nil, and in Go a nil `Env` means the child inherits
   * the parent's environment (`os.Environ()` is implied by `exec.Cmd`'s own
   * `environ()`). Setting it to a built list would drop both, and every
   * connection would fail with the CLI's credential-chain error.
   *
   * Pinned from the script's side rather than by fetching upstream's Go source
   * (which this repo cannot do in a test): the script asserts the dependency
   * at the point that would break. The two details that make it hold are that
   * `RunPasswordCommand` builds the command as
   * `exec.Command(config.Command, config.Args...)` at
   * `framework/postgresconn/postgresconn.go:563` (tag `transports/v2.4.0`) and
   * never assigns `cmd.Env` anywhere in the file, and that the command is not
   * run through a shell, which would be a second environment to lose them at.
   */
  const SCRIPT = fs.readFileSync(BIFROST_PG_PASSWORD_SCRIPT_PATH, "utf8");

  it("names the upstream line it depends on, so a reader can check it", () => {
    assert.match(
      SCRIPT,
      /postgresconn\.go:?563|RunPasswordCommand/,
      "the script must name the upstream function and line its environment inheritance rests on",
    );
    assert.match(
      SCRIPT,
      /cmd\.Env/,
      "the script must name the nil `cmd.Env` that makes inheritance work",
    );
  });

  it("is an executable the caller execs, not a shell it pipes through", () => {
    // Bifrost refuses `sh`/`bash` as `password_command.command`
    // (`validatePasswordCommand`), and this is why the shebang matters only for
    // a human running the file: the kernel gets the path and this `#!` line,
    // and the environment it was started with is the one it keeps.
    assert.ok(
      fs.statSync(BIFROST_PG_PASSWORD_SCRIPT_PATH).mode & 0o111,
      "the command must be executable: Bifrost execs the path, it does not source it",
    );
    assert.match(SCRIPT.split("\n")[0], /^#!\/bin\/sh$/);
  });

  it("needs PG_SECRET_ARN and the container credentials from that inherited environment", () => {
    // The positive statement of what the inheritance is for. A `PGPASSWORD`
    // fallback or a defensive re-derivation would hide a change to upstream's
    // environment handling instead of failing on it, so there is none.
    assert.ok(SCRIPT.includes("PG_SECRET_ARN"));
    // The prohibition is on shell code, not on the prose above it: the header
    // explains at length why there is no fallback, and reading that as a
    // fallback would make the explanation its own failure.
    const code = SCRIPT.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    assert.ok(
      !code.includes("PGPASSWORD"),
      "no fallback: the only source is the secret the task definition's ARN names",
    );
    assert.ok(
      !/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/.test(code),
      "the credential chain is the container's; the command must not spell a key",
    );
  });
});
