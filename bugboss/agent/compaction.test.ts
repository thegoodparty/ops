import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { TranscriptContext } from "@earendil-works/pi-ai";

import type { TimelineEvent, ToolApi, ToolResponse } from "../types";
import {
  createPiSummarizer,
  createStageCompaction,
  STAGE_FOR_TIMELINE_KIND,
  stageCompactionInstructions,
} from "./compaction";
import { createBossTools } from "./run";

const TIMELINE: TimelineEvent[] = [
  {
    id: 1,
    kind: "first_error",
    occurredAt: Date.parse("2026-09-30T19:02:11Z"),
    recordedAt: Date.parse("2026-09-30T19:21:00Z"),
    summary: "first 502 on POST /v1/outreach",
    evidenceUrl: "https://goodparty.grafana.net/explore?left=first-502",
  },
];

const text = (context: TranscriptContext): string => JSON.stringify(context.messages);

/**
 * A real Pi session over a scripted model. Everything between the scripted
 * turns -- the threshold check, the preparation, the summary request, the
 * compaction entry written to the session file -- is Pi's own code, which is
 * the part this change leans on and the part a unit test would have to fake.
 */
const runSession = async (args: {
  contextWindow: number;
  maxTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
  minTokens?: number;
  bigResult?: string;
  turns: (kit: typeof import("@earendil-works/pi-ai")) => unknown[];
}) => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const kit = await import("@earendil-works/pi-ai");
  const dir = await mkdtemp(join(tmpdir(), "bugboss-compaction-"));

  const faux = kit.fauxProvider({
    models: [{ id: "faux-opus", contextWindow: args.contextWindow, maxTokens: args.maxTokens }],
  });
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = faux.getModel();

  const summaryPrompts: string[] = [];
  const scripted = args.turns(kit);
  faux.setResponses(
    Array.from({ length: scripted.length * 3 }, () => (context: TranscriptContext) => {
      if (JSON.stringify(context).includes("context summarization assistant")) {
        summaryPrompts.push(text(context));
        return kit.fauxAssistantMessage(`## Goal\nsummary ${summaryPrompts.length}`);
      }
      const next = scripted.shift();
      return (next ?? kit.fauxAssistantMessage("done")) as ReturnType<
        typeof kit.fauxAssistantMessage
      >;
    }),
  );

  const settings = pi.SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: args.reserveTokens,
      keepRecentTokens: args.keepRecentTokens,
    },
  });

  let live: import("@earendil-works/pi-coding-agent").AgentSession | null = null;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const stages = createStageCompaction({
    settings,
    reserveTokens: args.reserveTokens,
    contextWindow: model.contextWindow,
    minTokens: args.minTokens ?? 0,
    timeline: async () => TIMELINE,
    summarize: createPiSummarizer({
      compact: pi.compact,
      modelRuntime,
      model,
      settings,
      session: () => live,
    }),
    log: (event, fields) => logs.push({ event, fields }),
  });

  const ok = (data?: unknown): ToolResponse<never> =>
    ({ ok: true, directives: [], ...(data === undefined ? {} : { data }) }) as ToolResponse<never>;
  const api = {
    reportRootCause: async () => ok(),
    getIncident: async () => ok({ big: args.bigResult ?? "a signal" }),
    trackTimelineEvent: async (event: { kind: TimelineEvent["kind"] }) => ok({ ...event, id: 2 }),
  } as unknown as ToolApi;
  const customTools = await createBossTools({
    api,
    boss: { tellBoss: async () => {} },
    onRootCause: () => stages.request("root_cause"),
    onTimelineEvent: (kind) => {
      const stage = STAGE_FOR_TIMELINE_KIND[kind];
      if (stage) stages.request(stage);
    },
  });

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager: settings,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    systemPromptOverride: () => "You are a test agent.",
    appendSystemPromptOverride: () => [],
    extensionFactories: [stages.extension],
  });
  await resourceLoader.reload();

  const sessionManager = pi.SessionManager.create(dir, join(dir, "sessions"), { id: "inc-1" });
  const { session } = await pi.createAgentSession({
    cwd: dir,
    model,
    modelRuntime,
    tools: customTools.map((tool) => tool.name),
    customTools,
    resourceLoader,
    settingsManager: settings,
    sessionManager,
  });
  live = session;

  await session.prompt("Incident inc-1 is yours.");
  const error = session.state.errorMessage ?? null;
  session.dispose();

  const file = sessionManager.getSessionFile();
  assert.ok(file, "the session was persisted");
  const entries = (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; id?: string; details?: { stage?: string } });
  return {
    entries,
    compactions: entries.filter((entry) => entry.type === "compaction"),
    summaryPrompts,
    logs,
    error,
    reserveAfter: settings.getCompactionReserveTokens(model),
  };
};

// A window this size never reaches the backstop, so every compaction below
// is one a stage asked for.
const roomy = { contextWindow: 1_000_000, maxTokens: 1_000, reserveTokens: 148_000, keepRecentTokens: 10 };

describe("stage compaction, through a real Pi session", () => {
  test("each transition compacts exactly once, with its own prompt and the timeline", async () => {
    const run = await runSession({
      ...roomy,
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        fauxAssistantMessage(
          fauxToolCall("report_root_cause", { cause: "a missing index", explainedSignalIds: ["s1"] }),
        ),
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        fauxAssistantMessage(
          fauxToolCall("track_incident_timeline_event", {
            kind: "fix_pr_opened",
            occurredAt: Date.parse("2026-09-30T19:40:14Z"),
            summary: "opened omni#2260",
            evidenceUrl: "https://github.com/thegoodparty/omni/pull/2260",
          }),
        ),
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        // Recording an event that is not a transition compacts nothing.
        fauxAssistantMessage(
          fauxToolCall("track_incident_timeline_event", {
            kind: "impact_confirmed",
            occurredAt: Date.parse("2026-09-30T19:41:00Z"),
            summary: "412 users",
          }),
        ),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.error, null);
    assert.deepEqual(
      run.compactions.map((entry) => entry.details?.stage),
      ["root_cause", "fix_opened"],
      "one compaction per transition, in order, and none for a plain event",
    );
    assert.equal(run.summaryPrompts.length, 2, "one summary call per transition");
    assert.match(run.summaryPrompts[0], /moved from investigating to fixing/);
    assert.match(run.summaryPrompts[1], /fix pull request for this incident has just been opened/);
    for (const prompt of run.summaryPrompts) {
      assert.match(prompt, /first 502 on POST \/v1\/outreach/, "the timeline is in every stage prompt");
      assert.match(prompt, /2026-09-30T19:02:11\.000Z first_error/);
    }
    assert.equal(run.reserveAfter, roomy.reserveTokens, "the backstop's reserve is back");
  });

  test("two transitions in one turn compact once, for the later stage", async () => {
    const run = await runSession({
      ...roomy,
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        fauxAssistantMessage([
          fauxToolCall("report_root_cause", { cause: "a missing index", explainedSignalIds: ["s1"] }),
          fauxToolCall("track_incident_timeline_event", {
            kind: "fix_pr_opened",
            occurredAt: Date.parse("2026-09-30T19:40:14Z"),
            summary: "opened omni#2260",
          }),
        ]),
        fauxAssistantMessage("done"),
      ],
    });

    assert.deepEqual(run.compactions.map((entry) => entry.details?.stage), ["fix_opened"]);
    assert.ok(run.logs.some((log) => log.event === "stage_compaction_coalesced"));
  });

  test("the session file keeps every entry from before a compaction", async () => {
    const run = await runSession({
      ...roomy,
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        fauxAssistantMessage(
          fauxToolCall("report_root_cause", { cause: "a missing index", explainedSignalIds: ["s1"] }),
        ),
        fauxAssistantMessage("done"),
      ],
    });

    const at = run.entries.findIndex((entry) => entry.type === "compaction");
    assert.ok(at > 0, "it compacted");
    const compaction = run.entries[at] as unknown as { firstKeptEntryId: string };
    const before = run.entries.slice(0, at);
    const toolResults = before.filter(
      (entry) =>
        entry.type === "message" &&
        (entry as { message?: { role?: string } }).message?.role === "toolResult",
    );
    assert.equal(toolResults.length, 3, "every tool result before the compaction is still on disk");
    // The anchor: the kept entry is an earlier line of the same file, so the
    // summarised span is exactly the entries before it.
    assert.ok(before.some((entry) => entry.id === compaction.firstKeptEntryId));
  });

  test("a transition on a small context is skipped rather than paid for", async () => {
    const run = await runSession({
      ...roomy,
      minTokens: 50_000,
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        fauxAssistantMessage(
          fauxToolCall("report_root_cause", { cause: "a missing index", explainedSignalIds: ["s1"] }),
        ),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.compactions.length, 0);
    assert.ok(run.logs.some((log) => log.event === "stage_compaction_skipped"));
    assert.equal(run.reserveAfter, roomy.reserveTokens);
  });

  test("the threshold backstop still fires, with Pi's own prompt", async () => {
    // 2,000 tokens of window and 500 of reserve: a ~2,500-token tool result
    // puts the projection over, with no stage anywhere in the run.
    const run = await runSession({
      contextWindow: 2_000,
      maxTokens: 200,
      reserveTokens: 500,
      keepRecentTokens: 10,
      bigResult: "x".repeat(10_000),
      turns: ({ fauxAssistantMessage, fauxToolCall }) => [
        fauxAssistantMessage(fauxToolCall("get_incident", {})),
        fauxAssistantMessage("done"),
      ],
    });

    assert.equal(run.compactions.length, 1, "the backstop compacted");
    assert.equal(run.compactions[0].details?.stage, undefined);
    assert.doesNotMatch(run.summaryPrompts[0], /Additional focus/);
  });
});

test("the stage prompt says what to do when nothing has been recorded", () => {
  const prompt = stageCompactionInstructions("root_cause", []);
  assert.match(prompt, /No timeline events have been recorded yet/);
  assert.match(prompt, /track_incident_timeline_event/);
});
