// The URL seams the eval harness points at its stand-ins.
//
// Every one of these is production code that production never configures:
// `SLACK_API_URL` and `BUGBOSS_GITHUB_URL` are unset in the task definition.
// So the claim worth pinning is not that the overrides work -- the harness
// finds that out the first time it runs -- but that with both unset, every
// request, every constructor option, every environment variable and every
// line of git config is exactly what it was before the seam existed. Each
// test here states the pre-seam value literally rather than computing it,
// because a test that derives its expectation from the code under test would
// pass whatever the code did.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

import {
  agentOptionsFromEnv,
  configureGitCredentials,
  DEFAULT_OMNI_REPO,
  gitCredentialKey,
} from "./agent/run";
import { createGitHubRunsPort } from "./agent/rerun";
import {
  CHILD_BASE_ENV_NAMES,
  gitHubTokenEnv,
  hasAwsCredentialPath,
  pickBaseEnv,
  pickEndpointEnv,
} from "./dispatcher/env";
import {
  createInstallationToken,
  createPrStateReader,
  GITHUB_DOT_COM,
  gitHubEndpoints,
} from "./github";
import {
  createRotationReader,
  createSlackClient,
  createSlackFileUploader,
  slackApiOptions,
} from "./slack/client";

const STANDIN = "https://github:8444";

/** What a production container's environment looks like, minus secrets. */
const PROD_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/agent",
  AWS_REGION: "us-west-2",
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/role",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_INSTALLATION_ID: "2",
  SLACK_BOT_TOKEN: "xoxb",
  GRAFANA_URL: "https://goodparty.grafana.net",
  BUGBOSS_BUCKET: "bugboss-prod",
};

/** Captures every fetch while the body runs, answering each with `respond`. */
const capturingFetch = async <T>(
  respond: (url: string) => Response,
  body: (urls: string[]) => Promise<T>,
): Promise<{ urls: string[]; result: T }> => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return respond(url);
  }) as typeof fetch;
  try {
    return { urls, result: await body(urls) };
  } finally {
    globalThis.fetch = original;
  }
};

describe("where GitHub is", () => {
  test("unset is github.com, spelled the way every call site used to", () => {
    assert.deepEqual(gitHubEndpoints(undefined), {
      webUrl: "https://github.com",
      host: "github.com",
      apiUrl: "https://api.github.com",
      enterprise: false,
    });
    assert.equal(gitHubEndpoints(""), GITHUB_DOT_COM);
    assert.equal(gitHubEndpoints("https://github.com"), GITHUB_DOT_COM);
    assert.equal(gitHubEndpoints("https://github.com/"), GITHUB_DOT_COM);
  });

  test("any other host is Enterprise-shaped, port and all", () => {
    assert.deepEqual(gitHubEndpoints(STANDIN), {
      webUrl: STANDIN,
      host: "github:8444",
      apiUrl: `${STANDIN}/api/v3`,
      enterprise: true,
    });
  });

  test("a value that is not a bare https origin is refused, not repaired", () => {
    assert.throws(() => gitHubEndpoints("http://github:8444"), /must be https/);
    assert.throws(() => gitHubEndpoints("https://github:8444/api/v3"), /no path/);
    assert.throws(() => gitHubEndpoints("github:8444"), /must be https|Invalid URL/);
  });
});

describe("the closing report's PR states", () => {
  const ok = () =>
    new Response(JSON.stringify({ state: "open", merged_at: null }), {
      headers: { "content-type": "application/json" },
    });

  test("unset reads api.github.com, and only for github.com PR urls", async () => {
    const { urls, result } = await capturingFetch(ok, () =>
      createPrStateReader(async () => "t").states([
        "https://github.com/thegoodparty/omni/pull/7",
        "https://github.com/thegoodparty/omni/pull/8/files",
        `${STANDIN}/thegoodparty/omni/pull/9`,
        "https://github.com.evil.example/thegoodparty/omni/pull/10",
      ]),
    );
    assert.deepEqual(urls.sort(), [
      "https://api.github.com/repos/thegoodparty/omni/pulls/7",
      "https://api.github.com/repos/thegoodparty/omni/pulls/8",
    ]);
    assert.deepEqual(Object.keys(result).sort(), [
      "https://github.com/thegoodparty/omni/pull/7",
      "https://github.com/thegoodparty/omni/pull/8/files",
    ]);
  });

  test("set, it reads the stand-in's /api/v3 and ignores github.com urls", async () => {
    const endpoints = gitHubEndpoints(STANDIN);
    const { urls } = await capturingFetch(ok, () =>
      createPrStateReader(async () => "t", endpoints).states([
        `${STANDIN}/thegoodparty/omni/pull/9`,
        "https://github.com/thegoodparty/omni/pull/7",
      ]),
    );
    assert.deepEqual(urls, [`${STANDIN}/api/v3/repos/thegoodparty/omni/pulls/9`]);
  });
});

describe("minting an installation token", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const app = { appId: "123", privateKey, installationId: "42" };
  const minted = () =>
    new Response(
      JSON.stringify({
        token: "ghs_minted",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { contents: "write" },
        repository_selection: "all",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );

  test("unset asks api.github.com, as the library always did", async () => {
    const { urls, result } = await capturingFetch(minted, () =>
      createInstallationToken(app)(),
    );
    assert.equal(result, "ghs_minted");
    assert.deepEqual(urls, [
      "https://api.github.com/app/installations/42/access_tokens",
    ]);
  });

  test("set, it asks the stand-in", async () => {
    const { urls } = await capturingFetch(minted, () =>
      createInstallationToken(app, gitHubEndpoints(STANDIN))(),
    );
    assert.deepEqual(urls, [`${STANDIN}/api/v3/app/installations/42/access_tokens`]);
  });
});

describe("rerun_ci's two calls", () => {
  const run = () =>
    new Response(
      JSON.stringify({ id: 5, run_attempt: 1, status: "completed", conclusion: "failure", name: "ci", html_url: "x" }),
      { headers: { "content-type": "application/json" } },
    );

  test("with no base url the port still defaults to api.github.com", async () => {
    const { urls } = await capturingFetch(run, () =>
      createGitHubRunsPort({ token: () => "t" }).getRun("thegoodparty/omni", 5),
    );
    assert.deepEqual(urls, ["https://api.github.com/repos/thegoodparty/omni/actions/runs/5"]);
  });

  test("the stand-in's base url is honoured", async () => {
    const { urls } = await capturingFetch(run, () =>
      createGitHubRunsPort({
        token: () => "t",
        baseUrl: gitHubEndpoints(STANDIN).apiUrl,
      }).getRun("thegoodparty/omni", 5),
    );
    assert.deepEqual(urls, [`${STANDIN}/api/v3/repos/thegoodparty/omni/actions/runs/5`]);
  });
});

describe("the agent's launch options", () => {
  const launch = {
    BUGBOSS_INCIDENT_ID: "inc-1",
    BUGBOSS_S3_BUCKET: "b",
    BUGBOSS_SESSION_REF: "sessions/inc-1.jsonl",
  };

  test("unset carries no github url at all, and clones github.com", () => {
    const options = agentOptionsFromEnv(launch, 0);
    assert.equal("githubUrl" in options, false);
    assert.equal("extensions" in options, false);
    assert.equal(options.omniRepoUrl, "https://github.com/thegoodparty/omni.git");
  });

  test("set, both reach the options", () => {
    const options = agentOptionsFromEnv(
      {
        ...launch,
        BUGBOSS_GITHUB_URL: STANDIN,
        BUGBOSS_OMNI_REPO: `${STANDIN}/thegoodparty/omni.git`,
      },
      0,
    );
    assert.equal(options.githubUrl, STANDIN);
    assert.equal(options.omniRepoUrl, `${STANDIN}/thegoodparty/omni.git`);
  });
});

describe("git's credential helper", () => {
  test("the default remote keys the helper on github.com, as it always was", () => {
    assert.equal(gitCredentialKey(DEFAULT_OMNI_REPO), "credential.https://github.com.helper");
  });

  test("a stand-in remote keys it on the stand-in's host and port", () => {
    assert.equal(
      gitCredentialKey(`${STANDIN}/thegoodparty/omni.git`),
      "credential.https://github:8444.helper",
    );
  });

  test("a remote that is not https keeps the production key", () => {
    assert.equal(gitCredentialKey("/tmp/omni.git"), "credential.https://github.com.helper");
    assert.equal(gitCredentialKey("file:///tmp/omni.git"), "credential.https://github.com.helper");
  });

  test("the global config written with no remote named is byte-for-byte the old one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugboss-gitcred-"));
    const file = join(dir, "gitconfig");
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = file;
    try {
      await configureGitCredentials();
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
    assert.equal(
      await readFile(file, "utf8"),
      [
        '[credential "https://github.com"]',
        '\thelper = "!f() { echo \\"username=x-access-token\\"; echo \\"password=$GITHUB_TOKEN\\"; }; f"',
        "[user]",
        "\tname = bugboss[bot]",
        "\temail = bugboss@goodparty.org",
        "",
      ].join("\n"),
    );
  });
});

describe("the child's environment", () => {
  test("a production parent contributes nothing through the endpoint seam", () => {
    assert.deepEqual(pickEndpointEnv(PROD_ENV), {});
    assert.deepEqual(pickEndpointEnv({ ...PROD_ENV, BUGBOSS_GITHUB_URL: "https://github.com" }), {
      BUGBOSS_GITHUB_URL: "https://github.com",
    });
  });

  test("the base allowlist is unchanged", () => {
    assert.deepEqual(
      [...CHILD_BASE_ENV_NAMES],
      [
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ],
    );
    assert.deepEqual(pickBaseEnv({ ...PROD_ENV, BUGBOSS_GITHUB_URL: STANDIN }), {
      PATH: PROD_ENV.PATH,
      HOME: PROD_ENV.HOME,
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: PROD_ENV.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
    });
  });

  test("a sim parent's static keys reach the child and count as a credential path", () => {
    const sim = { ...PROD_ENV, AWS_ACCESS_KEY_ID: "AKIASIM", AWS_SECRET_ACCESS_KEY: "fake", AWS_PROFILE: "default" };
    delete (sim as Record<string, string | undefined>).AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const env = pickBaseEnv(sim);
    assert.equal(env.AWS_ACCESS_KEY_ID, "AKIASIM");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "fake");
    assert.equal("AWS_PROFILE" in env, false, "a named profile never reaches the child");
    assert.ok(hasAwsCredentialPath(env));
    assert.equal(hasAwsCredentialPath({ AWS_ACCESS_KEY_ID: "AKIASIM" }), false, "a key id alone is not a credential");
  });

  test("a sim parent hands over its endpoints, its trust, and GH_HOST", () => {
    assert.deepEqual(
      pickEndpointEnv({
        ...PROD_ENV,
        BUGBOSS_GITHUB_URL: STANDIN,
        BUGBOSS_OMNI_REPO: `${STANDIN}/thegoodparty/omni.git`,
        NODE_EXTRA_CA_CERTS: "/sim/ca.pem",
        SSL_CERT_FILE: "/sim/ca.pem",
        GIT_SSL_CAINFO: "/sim/ca.pem",
        AWS_CA_BUNDLE: "/sim/ca.pem",
        npm_config_registry: "http://npm:4873",
        PRISMA_ENGINES_MIRROR: "http://mirror:4874",
        AWS_ENDPOINT_URL: "https://aws:8446",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://proxy:8443",
        AWS_ENDPOINT_URL_S3: "http://minio:9000",
        AWS_ENDPOINT_URLS: "not a real variable",
      }),
      {
        BUGBOSS_GITHUB_URL: STANDIN,
        BUGBOSS_OMNI_REPO: `${STANDIN}/thegoodparty/omni.git`,
        NODE_EXTRA_CA_CERTS: "/sim/ca.pem",
        SSL_CERT_FILE: "/sim/ca.pem",
        GIT_SSL_CAINFO: "/sim/ca.pem",
        AWS_CA_BUNDLE: "/sim/ca.pem",
        npm_config_registry: "http://npm:4873",
        PRISMA_ENGINES_MIRROR: "http://mirror:4874",
        AWS_ENDPOINT_URL: "https://aws:8446",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://proxy:8443",
        AWS_ENDPOINT_URL_S3: "http://minio:9000",
        GH_HOST: "github:8444",
      },
    );
  });

  test("a minted token goes where it always went, and to GH_ENTERPRISE_TOKEN only on another host", () => {
    assert.deepEqual(gitHubTokenEnv("ghs_x", PROD_ENV), {
      GITHUB_TOKEN: "ghs_x",
      GH_TOKEN: "ghs_x",
    });
    assert.deepEqual(gitHubTokenEnv("ghs_x", { GH_HOST: "github:8444" }), {
      GITHUB_TOKEN: "ghs_x",
      GH_TOKEN: "ghs_x",
      GH_ENTERPRISE_TOKEN: "ghs_x",
    });
  });
});

describe("Slack's Web API base", () => {
  test("unset adds no option at all", () => {
    assert.deepEqual(slackApiOptions(undefined), {});
    assert.deepEqual(slackApiOptions(""), {});
  });

  test("set, it is normalised to the trailing slash the SDK joins onto", () => {
    assert.deepEqual(slackApiOptions("https://slack:8445/api"), {
      slackApiUrl: "https://slack:8445/api/",
    });
    assert.deepEqual(slackApiOptions("https://slack:8445/api/"), {
      slackApiUrl: "https://slack:8445/api/",
    });
  });

  /**
   * Every one of the three WebClients, driven through a stubbed axios adapter
   * so nothing leaves the process, and read back as the absolute url axios
   * would have requested.
   */
  const requested = async (
    body: () => Promise<unknown>,
  ): Promise<string[]> => {
    const real = axios.defaults.adapter;
    const urls: string[] = [];
    axios.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      urls.push(new URL(config.url ?? "", config.baseURL).toString());
      return Promise.resolve({
        data: {
          ok: true,
          ts: "1.000001",
          permalink: "https://x.slack.com/p1",
          users: ["U1"],
          upload_url: "https://files.slack.test/upload",
          file_id: "F1",
          messages: [],
          response_metadata: { next_cursor: "" },
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
        request: {},
      } as AxiosResponse);
    }) as typeof axios.defaults.adapter;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
    try {
      await body();
    } finally {
      axios.defaults.adapter = real;
      globalThis.fetch = original;
    }
    return urls;
  };

  const everyClient = (apiUrl?: string) => async () => {
    const slack = createSlackClient("xoxb", "C1", apiUrl);
    await slack.post(null, "hi");
    await slack.replies({ channel: "C1", threadTs: "1.0" });
    await createSlackFileUploader("xoxb", apiUrl).upload({
      channel: "C1",
      threadTs: "1.0",
      filename: "a.md",
      title: "a",
      content: "a",
      comment: "a",
    });
    await createRotationReader("xoxb", "S1", apiUrl)();
  };

  test("unset, every client calls slack.com", async () => {
    assert.deepEqual(await requested(everyClient()), [
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/conversations.replies",
      "https://slack.com/api/files.getUploadURLExternal",
      "https://slack.com/api/files.completeUploadExternal",
      "https://slack.com/api/usergroups.users.list",
    ]);
  });

  test("set, every client calls the stand-in", async () => {
    assert.deepEqual(await requested(everyClient("https://slack:8445/api")), [
      "https://slack:8445/api/chat.postMessage",
      "https://slack:8445/api/conversations.replies",
      "https://slack:8445/api/files.getUploadURLExternal",
      "https://slack:8445/api/files.completeUploadExternal",
      "https://slack:8445/api/usergroups.users.list",
    ]);
  });
});
