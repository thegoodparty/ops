import { parsePiSession } from "./adapters/pi-session";

/**
 * Tiny synthetic Pi session transcripts for the evals tests. Real transcripts
 * hold production logs and never enter the repo, so every test builds the
 * shape it needs here instead.
 */

export const RATES_PER_M = {
  input: 5.5,
  output: 27.5,
  cacheRead: 0.55,
  cacheWrite5m: 6.875,
  cacheWrite1h: 11,
};

export interface FixtureCall {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface FixtureTurn {
  /** Minutes after the session start that the request was sent. */
  at: number;
  read: number;
  write: number;
  output?: number;
  input?: number;
  api?: "bedrock-invoke-model" | "bedrock-converse-stream";
  calls?: FixtureCall[];
}

const START = Date.parse("2026-09-29T10:00:00Z");

export const fixture = (options?: {
  systemPrompt?: string;
  toolNames?: string[];
  start?: number;
}) => {
  const start = options?.start ?? START;
  const iso = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const lines: object[] = [
    { type: "session", version: 3, id: "fx", timestamp: iso(0), cwd: "/work/fx/omni" },
    {
      type: "custom",
      customType: "bugboss_prompt",
      data: {
        systemPrompt: options?.systemPrompt ?? "You are the incident agent.",
        toolNames: options?.toolNames ?? ["bash", "monitor", "contact_human"],
        modelId: "us.anthropic.claude-opus-5",
      },
    },
  ];
  let ids = 0;
  const id = () => `e${++ids}`;
  const builder = {
    launch(at: number) {
      lines.push({
        type: "message",
        id: id(),
        timestamp: iso(at),
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      });
      return builder;
    },
    turn(turn: FixtureTurn) {
      const input = turn.input ?? 2;
      const output = turn.output ?? 100;
      const api = turn.api ?? "bedrock-invoke-model";
      const oneHour = api === "bedrock-invoke-model";
      const writeRate = oneHour ? RATES_PER_M.cacheWrite1h : RATES_PER_M.cacheWrite5m;
      const cost = {
        input: (input * RATES_PER_M.input) / 1e6,
        output: (output * RATES_PER_M.output) / 1e6,
        cacheRead: (turn.read * RATES_PER_M.cacheRead) / 1e6,
        cacheWrite: (turn.write * writeRate) / 1e6,
        total: 0,
      };
      cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
      const calls = (turn.calls ?? []).map((call) => ({ ...call, id: id() }));
      lines.push({
        type: "message",
        id: id(),
        timestamp: iso(turn.at + 0.1),
        message: {
          role: "assistant",
          content: calls.map((call) => ({
            type: "toolCall",
            id: call.id,
            name: call.name,
            arguments: call.args ?? {},
          })),
          api,
          provider: "amazon-bedrock",
          model: "us.anthropic.claude-opus-5",
          usage: {
            input,
            output,
            cacheRead: turn.read,
            cacheWrite: turn.write,
            totalTokens: input + output + turn.read + turn.write,
            cost,
            cacheWrite1h: oneHour ? turn.write : 0,
          },
          stopReason: "toolUse",
          timestamp: start + turn.at * 60_000,
        },
      });
      for (const call of calls) {
        lines.push({
          type: "message",
          id: id(),
          timestamp: iso(turn.at + 0.2),
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: call.result ?? "ok" }],
            isError: call.isError ?? false,
          },
        });
      }
      return builder;
    },
    crash(at: number, error = "thinking.adaptive.block_binding: Extra inputs are not permitted") {
      lines.push({
        type: "message",
        id: id(),
        timestamp: iso(at),
        message: {
          role: "assistant",
          content: [],
          api: "bedrock-invoke-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: error,
          timestamp: start + at * 60_000,
        },
      });
      lines.push({
        type: "custom",
        customType: "bugboss_exit",
        id: id(),
        timestamp: iso(at + 0.01),
        data: { reason: "turn_error", at: start + (at + 0.01) * 60_000, attempt: 1, error },
      });
      return builder;
    },
    jsonl: () => lines.map((line) => JSON.stringify(line)).join("\n"),
  };
  return builder;
};

/**
 * Investigates, opens a PR, waits three hours on monitor, loops on refused
 * contact_human calls, is relaunched, then relaunched out of a block_binding
 * crash, then goes cold with no gap at all.
 */
export const postPrRun = () =>
  parsePiSession(
    "a",
    fixture()
      .launch(0)
      .turn({ at: 0, read: 0, write: 70_000, calls: [{ name: "get_incident" }] })
      .turn({
        at: 1,
        read: 70_000,
        write: 5_000,
        calls: [{ name: "report_root_cause", result: "error: signals missing" }],
      })
      .turn({ at: 2, read: 75_000, write: 5_000, calls: [{ name: "report_root_cause" }] })
      .turn({
        at: 3,
        read: 80_000,
        write: 40_000,
        calls: [{ name: "bash", args: { command: "gh pr create --title fix" } }],
      })
      .turn({ at: 4, read: 120_000, write: 30_000, calls: [{ name: "monitor" }] })
      .turn({
        at: 184,
        read: 0,
        write: 152_000,
        calls: [{ name: "contact_human", result: "error: message is 600 characters" }],
      })
      .turn({
        at: 185,
        read: 152_000,
        write: 1_000,
        calls: [{ name: "contact_human", result: "error: message is 580 characters" }],
      })
      .turn({ at: 186, read: 153_000, write: 1_000, calls: [{ name: "bash", args: { command: "ls" } }] })
      .turn({
        at: 187,
        read: 154_000,
        write: 1_000,
        calls: [{ name: "contact_human", result: "error: message is 560 characters" }],
      })
      .turn({ at: 188, read: 155_000, write: 1_000, calls: [{ name: "contact_human" }] })
      .launch(600)
      .turn({ at: 600, read: 0, write: 160_000 })
      .launch(899)
      .crash(899.5)
      .launch(905)
      .turn({ at: 905, read: 0, write: 162_000 })
      .turn({ at: 906, read: 0, write: 163_000 })
      .jsonl(),
  );

