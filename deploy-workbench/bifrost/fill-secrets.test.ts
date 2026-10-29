import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `fill-secrets.sh --check`, executed against a stub `aws`.
 *
 * The rest of this directory's tests read the script as text, which is enough
 * to pin the container and key names it writes. What text cannot show is the
 * behaviour `--check` is relied on for: it still fails when the gateway has no
 * `BIFROST_SETUP_TOKEN`, and it no longer mentions the deleted `bifrost/vk-mint`
 * copy at all (decision 3 of `docs/bifrost-virtual-keys.md`). So this runs the
 * real script — bash, jq and openssl as the script requires them — with a
 * stub `aws` first on `PATH` and fixtures in place of Secrets Manager. It never
 * reaches AWS and never sees a real value.
 *
 * `--check` and `--generated-only --dry-run` are the two modes that write
 * nothing, which is why they are the two the test drives. The stub is
 * deliberately dumb: it answers the four calls those modes make and exits
 * non-zero on anything else, so a new AWS call in the script fails the test
 * rather than hanging.
 */

const SCRIPT_PATH = path.resolve(__dirname, "fill-secrets.sh");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");
const ACCOUNT_ID = "024901689212";
const REGION = "us-west-2";

const STUB_AWS = `#!/usr/bin/env bash
set -uo pipefail
args=("$@")
service="\${args[0]:-}"
op="\${args[1]:-}"
case "\${service} \${op}" in
  "sts get-caller-identity")
    printf '%s\\n' "\${STUB_ACCOUNT:-${ACCOUNT_ID}}"
    exit 0
    ;;
  "configure get")
    printf '%s\\n' "\${STUB_REGION:-${REGION}}"
    exit 0
    ;;
esac
id=""
for ((i = 0; i < \${#args[@]}; i++)); do
  if [[ "\${args[i]}" == "--secret-id" ]]; then id="\${args[i + 1]:-}"; fi
done
[[ -n "$id" ]] || { echo "stub aws: no --secret-id in $*" >&2; exit 1; }
state="$(jq -r --arg id "$id" '
  if has($id) then (if .[$id] == null then "empty" else "present" end) else "absent" end
' "$FILL_SECRETS_FIXTURES")"
case "$op" in
  describe-secret)
    if [[ "$state" == "absent" ]]; then
      echo "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: Secrets Manager can't find the specified secret." >&2
      exit 254
    fi
    printf 'arn:aws:secretsmanager:%s:%s:secret:%s-StUb01\\n' "\${STUB_REGION:-${REGION}}" "\${STUB_ACCOUNT:-${ACCOUNT_ID}}" "$id"
    ;;
  get-secret-value)
    if [[ "$state" != "present" ]]; then
      echo "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret value." >&2
      exit 254
    fi
    jq -c --arg id "$id" '.[$id]' "$FILL_SECRETS_FIXTURES"
    ;;
  *)
    echo "stub aws: unsupported call: $*" >&2
    exit 1
    ;;
esac
`;

/** A value of `null` is a container Pulumi created with no version yet. */
type Fixtures = Record<string, Record<string, string> | null>;

const GATEWAY_KEYS = {
  BIFROST_ENCRYPTION_KEY: "generated-value-not-read-by-a-test",
  BIFROST_ADMIN_USERNAME: "bifrost-admin",
  BIFROST_ADMIN_PASSWORD: "generated-value-not-read-by-a-test",
  BIFROST_SETUP_TOKEN: "generated-value-not-read-by-a-test",
  FIREWORKS_API_KEY: "human-value-not-read-by-a-test",
};

const OAUTH_KEYS = {
  OAUTH2_PROXY_COOKIE_SECRET: "generated-value-not-read-by-a-test",
  OAUTH2_PROXY_CLIENT_ID: "human-value-not-read-by-a-test",
  OAUTH2_PROXY_CLIENT_SECRET: "human-value-not-read-by-a-test",
};

const completeSecrets = (): Fixtures => ({
  "bifrost/gateway": { ...GATEWAY_KEYS },
  "bifrost/oauth2-proxy": { ...OAUTH_KEYS },
});

const GATEWAY_WITHOUT_TOKEN: Record<string, string> = { ...GATEWAY_KEYS };
delete GATEWAY_WITHOUT_TOKEN.BIFROST_SETUP_TOKEN;

const hasTool = (tool: string): boolean =>
  spawnSync("bash", ["-c", `command -v ${tool}`], {
    stdio: "ignore",
  }).status === 0;

const missingTools = ["bash", "jq", "openssl", "sed", "stat"].filter(
  (tool) => !hasTool(tool),
);
const skip = missingTools.length
  ? `needs ${missingTools.join(", ")} on PATH`
  : false;

/**
 * Runs the script with a stub `aws` first on `PATH`, fixtures in place of
 * Secrets Manager, and nothing inherited that could change which account or
 * region it thinks it is in.
 */
const runScript = (
  args: string[],
  fixtures: Fixtures,
): { status: number | null; output: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fill-secrets-test-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const stub = path.join(bin, "aws");
    fs.writeFileSync(stub, STUB_AWS, { mode: 0o755 });
    // `mode` above only applies at creation on some platforms; make it explicit.
    fs.chmodSync(stub, 0o755);
    const fixturesPath = path.join(dir, "secrets.json");
    fs.writeFileSync(fixturesPath, JSON.stringify(fixtures));

    const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FILL_SECRETS_FIXTURES: fixturesPath,
        AWS_REGION: REGION,
        STUB_ACCOUNT: ACCOUNT_ID,
        STUB_REGION: REGION,
        HOME: dir,
        // The script writes through a mktemp file, which needs a writable
        // TMPDIR; keeping it in the fixture directory keeps the run isolated.
        TMPDIR: dir,
      },
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("fill-secrets.sh --check, before and after the setup-token change", () => {
  it("never mentions the deleted bifrost/vk-mint copy, in the script or its output", { skip }, () => {
    // Decision 3 dropped the dedicated container. A line in the script that
    // still creates, copies or reports it is the stale-documentation bug this
    // PR exists to avoid, so the source is pinned too.
    assert.ok(!SCRIPT_SOURCE.includes("bifrost/vk-mint"));
    assert.ok(!SCRIPT_SOURCE.includes("VK_MINT_SECRET"));

    const { status, output } = runScript(["--check"], completeSecrets());
    assert.equal(status, 0, output);
    assert.ok(!output.includes("vk-mint"), output);
    // The two containers it does write are still announced.
    assert.match(output, /bifrost\/gateway/);
    assert.match(output, /bifrost\/oauth2-proxy/);
  });

  it("still fails when the gateway has no setup token", { skip }, () => {
    const { status, output } = runScript(["--check"], {
      "bifrost/gateway": { ...GATEWAY_WITHOUT_TOKEN },
      "bifrost/oauth2-proxy": { ...OAUTH_KEYS },
    });
    assert.equal(status, 2, output);
    assert.match(output, /Still unset \(1\): BIFROST_SETUP_TOKEN/, output);
    assert.ok(!output.includes("vk-mint"), output);
  });

  it("still reports a missing gateway container and every unset key", { skip }, () => {
    const { status, output } = runScript(["--check"], {
      "bifrost/oauth2-proxy": { ...OAUTH_KEYS },
    });
    assert.equal(status, 2, output);
    assert.match(output, /bifrost\/gateway[\s\S]*\(does not exist\)/, output);
    assert.match(output, /Still unset \(5\): BIFROST_ENCRYPTION_KEY/, output);
    assert.ok(!output.includes("vk-mint"), output);
  });

  it("passes when every required key is present", { skip }, () => {
    const { status, output } = runScript(["--check"], completeSecrets());
    assert.equal(status, 0, output);
    assert.match(output, /Every required key is present\./, output);
  });
});

describe("fill-secrets.sh --generated-only, which the gateway still needs", () => {
  it("generates the gateway's BIFROST_SETUP_TOKEN and announces two containers", { skip }, () => {
    const { status, output } = runScript(
      ["--generated-only", "--dry-run"],
      {},
    );
    assert.equal(status, 0, output);
    assert.match(output, /1\/2\s+bifrost\/gateway/, output);
    assert.match(output, /2\/2\s+bifrost\/oauth2-proxy/, output);
    assert.doesNotMatch(output, /3\/3/, output);
    assert.match(output, /BIFROST_SETUP_TOKEN: generated/, output);
    assert.match(output, /dry run: would write .*BIFROST_SETUP_TOKEN.* to bifrost\/gateway/, output);
    assert.ok(!output.includes("vk-mint"), output);
  });
});
