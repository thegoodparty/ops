import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { RunIncidentAgentOptions, RunIncidentAgentResult } from "../../bugboss/agent/run";
import type { IncidentView } from "../../bugboss/types";
import { ReplayCaseSchema } from "./case";
import { mergeAsHuman, replayOnce, type ChildConfig } from "./child";
import { statusOf } from "./run-phase";

const CONFIG: ChildConfig = {
  incidentId: "7",
  sessionKey: "sessions/incident/7/session.jsonl",
  workRoot: "/work",
  checkpoint: '{"type":"session","id":"7"}\n',
  view: { incident: { id: "7", status: "FIXING" }, signals: [] } as unknown as IncidentView,
  script: [{ on: "question", approveAndMerge: true, reply: "Merged." }],
  turnCap: 3,
  timeoutSeconds: 60,
  github: { apiUrl: "https://github/api/v3", owner: "o", repo: "r", prNumber: 5, humanToken: "h" },
  outPath: "/dev/null",
};

type Handler = (event: unknown, ctx: { abort: () => void }) => unknown;

/**
 * Stands in for a variant's runIncidentAgent, with a fake model deciding each
 * turn. It installs the extensions the way Pi does and fires turn_end after
 * each turn, so the harness's cap and the Boss wiring are exercised without a
 * model call.
 */
const fakeAgent = (turns: Array<(api: RunIncidentAgentOptions["api"]) => Promise<void>>, seen: { options?: RunIncidentAgentOptions }) =>
  async (options: RunIncidentAgentOptions): Promise<RunIncidentAgentResult> => {
    seen.options = options;
    const handlers: Handler[] = [];
    for (const factory of (options as { extensions?: Array<(pi: { on: (e: string, h: Handler) => void }) => void> }).extensions ?? []) {
      factory({ on: (_e, h) => handlers.push(h) });
    }
    let aborted = false;
    for (const turn of turns) {
      if (aborted) break;
      await turn(options.api);
      for (const h of handlers) await h({}, { abort: () => (aborted = true) });
    }
    return { sessionFile: "x", restored: true, timedOut: false, turnsExhausted: false, error: aborted ? "aborted" : null };
  };

test("the variant resumes from the in-memory checkpoint, with no clone and our extensions", async () => {
  const seen: { options?: RunIncidentAgentOptions } = {};
  const out = await replayOnce({ config: CONFIG, runIncidentAgent: fakeAgent([], seen), merge: async () => ({ merged: true, sha: "a", detail: "" }) });
  const options = seen.options as RunIncidentAgentOptions & { extensions: unknown[] };
  assert.equal(options.skipClone, true);
  assert.equal(options.workRoot, "/work");
  assert.equal((await options.store?.get(CONFIG.sessionKey))?.toString(), CONFIG.checkpoint);
  assert.equal(options.extensions.length, 1);
  assert.equal(out.stop.honoured, true);
});

test("a full after-PR phase: ask, merge, confirm, close", async () => {
  const out = await replayOnce({
    config: { ...CONFIG, turnCap: 10 },
    merge: async () => ({ merged: true, sha: "abc1234", detail: "merged" }),
    runIncidentAgent: fakeAgent(
      [
        async (api) => void (await api?.getIncident()),
        async (api) => void (await api?.tellBoss("question", "Green and approved; please merge.")),
        async (api) => {
          const answer = (await api?.peekDirectives())?.find((p) => p.directive.type === "boss_message");
          assert.ok(answer, "the scripted human answered");
          await api?.consumeDirective(answer.id);
        },
        async (api) => void (await api?.reportResolved({ prUrls: ["u"], evidence: "error rate 0 since deploy (query: ...)" })),
        async (api) => void (await api?.reportAnalysis({ postmortem: "What broke and why.", usersImpacted: 0, impactQuery: "q" })),
      ],
      {},
    ),
  });
  assert.equal(out.error, null);
  assert.equal(out.boss.merges[0].merged, true);
  assert.ok(out.boss.resolved[0].at >= out.boss.merges[0].at);
  assert.equal(out.boss.analysis?.postmortem, "What broke and why.");
  assert.equal(out.stop.capped, false);
});

test("the turn cap aborts the session and says so", async () => {
  const idle = async () => {};
  const out = await replayOnce({ config: CONFIG, runIncidentAgent: fakeAgent([idle, idle, idle, idle, idle], {}) });
  assert.equal(out.stop.turns, 3);
  assert.equal(out.stop.capped, true);
});

test("a variant that ignores extensions is caught, not trusted", async () => {
  const out = await replayOnce({
    config: CONFIG,
    runIncidentAgent: async () => ({ sessionFile: "x", restored: true, timedOut: false, turnsExhausted: false, error: null }),
  });
  assert.equal(out.stop.honoured, false);
  const { status, detail } = statusOf({ killed: false, overBudget: false, child: out, exitCode: 0, merged: false, resolvedAfterMerge: false });
  assert.equal(status, "error");
  assert.match(detail, /extensions/);
});

test("statusOf: budget beats timeout beats success", () => {
  const out = { result: null, error: null, boss: {} as never, stop: { turns: 1, capped: false, honoured: true }, startedAt: 0, endedAt: 1 };
  const base = { killed: false, overBudget: false, child: out, exitCode: 0, merged: true, resolvedAfterMerge: true };
  assert.equal(statusOf(base).status, "completed");
  assert.equal(statusOf({ ...base, resolvedAfterMerge: false }).status, "stalled");
  assert.equal(statusOf({ ...base, killed: true }).status, "timed_out");
  assert.equal(statusOf({ ...base, killed: true, overBudget: true }).status, "over_budget");
});

test("mergeAsHuman approves the head, then merges, as the human token", async () => {
  const calls: Array<{ url: string; method: string; auth: string; body?: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", auth: String((init?.headers as Record<string, string>).authorization), body: init?.body as string });
    if (url.endsWith("/merge")) return new Response(JSON.stringify({ merged: true, sha: "m1" }));
    if (url.endsWith("/reviews")) return new Response("{}");
    return new Response(JSON.stringify({ head: { sha: "h1" } }));
  }) as typeof fetch;
  const outcome = await mergeAsHuman(CONFIG.github, fetchImpl);
  assert.deepEqual(outcome, { merged: true, sha: "m1", detail: "merged" });
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST", "PUT"]);
  assert.equal(JSON.parse(calls[1].body as string).commit_id, "h1");
  assert.ok(calls.every((c) => c.auth === "token h"));
});

test("every committed case parses, and none carries a transcript", () => {
  const dir = join(__dirname, "cases");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 6);
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    ReplayCaseSchema.parse(JSON.parse(text));
    assert.ok(statSync(join(dir, file)).size < 4096, `${file} is too large to be only a pointer`);
  }
});

test("no Pi session is committed anywhere under bugboss-evals", () => {
  const root = join(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.name === "node_modules" ? [] : d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
    );
  for (const file of walk(root).filter((f) => /\.(jsonl|json|ndjson)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    assert.ok(!(text.includes('"type":"session"') && text.includes('"toolResult"')), `${file} looks like a session transcript`);
  }
});
