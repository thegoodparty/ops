/**
 * One side of a Tier 2 replay, in its own process.
 *
 * The parent (`run-phase.ts`) starts this with the variant's ops checkout as
 * `REPLAY_VARIANT_ROOT`, and this loads that checkout's `runIncidentAgent`,
 * so the code under test is the variant's and only the harness is ours. It
 * runs in its own process because the agent reads its GitHub, Bedrock and
 * TLS settings from the environment, and two sides of a pair must not share
 * one.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunIncidentAgentOptions, RunIncidentAgentResult } from "../../bugboss/agent/run";
import type { IncidentView } from "../../bugboss/types";
import { createFakeBoss, type BossRecord, type MergeOutcome, type ScriptStep } from "./fake-boss";

export interface ChildConfig {
  incidentId: string;
  sessionKey: string;
  workRoot: string;
  /** The checkpoint JSONL, already cut and rewritten. */
  checkpoint: string;
  view: IncidentView;
  script: ScriptStep[];
  turnCap: number;
  timeoutSeconds: number;
  modelId?: string;
  awsRegion?: string;
  github: {
    apiUrl: string;
    owner: string;
    repo: string;
    prNumber: number;
    /** A token the stand-in maps to a human login (GITHUB_STANDIN_HUMANS). */
    humanToken: string;
  };
  grafana?: { url: string; token: string };
  outPath: string;
}

export interface StopState {
  /** Turns this replay ran, counted on `turn_end`. */
  turns: number;
  capped: boolean;
  /** False when the variant never ran our extension, so the turn cap did nothing. */
  honoured: boolean;
}

export interface ChildOutput {
  result: RunIncidentAgentResult | null;
  error: string | null;
  boss: BossRecord;
  stop: StopState;
  startedAt: number;
  endedAt: number;
}

type TurnEndHandler = (event: unknown, ctx: { abort: () => void }) => unknown;
type ExtensionApi = { on: (event: "turn_end", handler: TurnEndHandler) => void };

/**
 * Stops the replay after `turnCap` turns by aborting the session, the same
 * stop BugBoss's own turn budget uses. The variant's budget is left alone:
 * hitting it is behaviour worth measuring, and this cap is the harness's.
 */
export const createStopExtension = (turnCap: number) => {
  const state: StopState = { turns: 0, capped: false, honoured: false };
  const extension = (pi: ExtensionApi) => {
    state.honoured = true;
    pi.on("turn_end", (_event, ctx) => {
      state.turns += 1;
      if (state.turns >= turnCap && !state.capped) {
        state.capped = true;
        ctx.abort();
      }
    });
  };
  return { extension, state: () => ({ ...state }) };
};

const memoryStore = (seed: Record<string, Buffer>) => {
  const objects = new Map(Object.entries(seed));
  return {
    get: async (key: string) => objects.get(key) ?? null,
    put: async (key: string, body: Buffer) => {
      objects.set(key, body);
    },
    list: async (prefix: string) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
  };
};

/** Approves the PR and merges it through the stand-in's REST API, as a person. */
export const mergeAsHuman = async (
  github: ChildConfig["github"],
  fetchImpl: typeof fetch = fetch,
): Promise<MergeOutcome> => {
  const base = `${github.apiUrl.replace(/\/$/, "")}/repos/${github.owner}/${github.repo}/pulls/${github.prNumber}`;
  const headers = {
    authorization: `token ${github.humanToken}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  };
  try {
    const pr = (await (await fetchImpl(base, { headers })).json()) as { head?: { sha?: string } };
    const review = await fetchImpl(`${base}/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({ event: "APPROVE", commit_id: pr.head?.sha, body: "Looks right." }),
    });
    if (!review.ok) return { merged: false, sha: null, detail: `review ${review.status}: ${await review.text()}` };
    const merge = await fetchImpl(`${base}/merge`, { method: "PUT", headers, body: JSON.stringify({ merge_method: "squash" }) });
    const text = await merge.text();
    if (!merge.ok) return { merged: false, sha: null, detail: `merge ${merge.status}: ${text}` };
    const body = JSON.parse(text) as { merged?: boolean; sha?: string; message?: string };
    return { merged: body.merged === true, sha: body.sha ?? null, detail: body.message ?? "merged" };
  } catch (error: unknown) {
    return { merged: false, sha: null, detail: error instanceof Error ? error.message : String(error) };
  }
};

export const replayOnce = async (args: {
  config: ChildConfig;
  runIncidentAgent: (options: RunIncidentAgentOptions) => Promise<RunIncidentAgentResult>;
  merge?: () => Promise<MergeOutcome>;
}): Promise<ChildOutput> => {
  const { config } = args;
  const boss = createFakeBoss({
    view: config.view,
    script: config.script,
    merge: args.merge ?? (() => mergeAsHuman(config.github)),
  });
  const stop = createStopExtension(config.turnCap);
  const startedAt = Date.now();
  let result: RunIncidentAgentResult | null = null;
  let error: string | null = null;
  try {
    const options: RunIncidentAgentOptions & { extensions: unknown[] } = {
      incidentId: config.incidentId,
      // Never dialled: `api` replaces the client this would build.
      bossBaseUrl: "http://boss.invalid",
      s3Bucket: "replay-memory",
      sessionKey: config.sessionKey,
      workRoot: config.workRoot,
      skipClone: true,
      store: memoryStore({ [config.sessionKey]: Buffer.from(config.checkpoint) }),
      api: boss.client,
      timeoutSeconds: config.timeoutSeconds,
      extensions: [stop.extension],
      ...(config.modelId ? { modelId: config.modelId } : {}),
      ...(config.awsRegion ? { awsRegion: config.awsRegion } : {}),
      ...(config.grafana ? { grafana: config.grafana } : {}),
    };
    result = await args.runIncidentAgent(options);
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { result, error, boss: boss.record(), stop: stop.state(), startedAt, endedAt: Date.now() };
};

if (require.main === module) {
  const root = process.env.REPLAY_VARIANT_ROOT;
  const configPath = process.env.REPLAY_CONFIG;
  if (!root || !configPath) {
    console.error("REPLAY_VARIANT_ROOT and REPLAY_CONFIG are required");
    process.exit(2);
  }
  // The variant's own copy, resolved against its own node_modules.
  const variant = require(join(root, "bugboss", "agent", "run.ts")) as {
    runIncidentAgent: (options: RunIncidentAgentOptions) => Promise<RunIncidentAgentResult>;
  };
  const config = JSON.parse(require("node:fs").readFileSync(configPath, "utf8")) as ChildConfig;
  replayOnce({ config, runIncidentAgent: variant.runIncidentAgent })
    .then(async (output) => {
      await writeFile(config.outPath, JSON.stringify(output));
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
