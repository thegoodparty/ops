import type { ChildProcess } from "node:child_process";

/**
 * The system under test, behind the surfaces the world sees: how to build it
 * from a ref, how to start it against this run's fakes, and where it listens.
 * The harness knows nothing else about it; a second runtime is a second file
 * here and nothing in run.ts.
 */

export interface RuntimeBuild {
  dir: string;
  /** The commit built, when the runtime builds from a git ref. */
  sha?: string;
}

/** Everything of the run's world a runtime may need to be told about. Values, not variable names: each runtime maps them to its own config. */
export interface World {
  slack: { apiUrl: string; botToken: string; signingSecret: string; botUserId: string; channel: string };
  grafana: { url: string; serviceAccountToken: string; webhookSecret: string };
  github: { repoUrl: string; tokenFile: string; caFile: string };
  aws: { region: string; credentialsUrl: string; s3Url: string };
  postgresUrl: string;
  /** Where the runtime may write its database, sessions and anything else that is its own. */
  stateDir: string;
}

export interface RuntimeLaunch {
  child: ChildProcess;
  healthUrl: string;
  alertUrl: string;
  /** Where the Slack sim delivers Events API callbacks. Null for a runtime that cannot take them over HTTP. */
  slackEventsUrl: string | null;
  /** Has the incident this run opened reached closed. */
  closed: () => Promise<boolean>;
}

export interface Runtime {
  id: string;
  modelUpstream: "bedrock" | "anthropic";
  build: (ref: string, out: string) => Promise<RuntimeBuild>;
  launch: (opts: {
    build: RuntimeBuild;
    /** PATH, HOME, LANG, the model proxy's endpoint and nothing runtime-specific. */
    env: Record<string, string>;
    /** `http` is where the runtime listens; `spare` are free ports it may use for anything internal. */
    ports: { http: number; spare: number[] };
    workRoot: string;
    world: World;
    /** Run as this user, which holds no secrets. */
    runAs?: string;
  }) => Promise<RuntimeLaunch>;
}
