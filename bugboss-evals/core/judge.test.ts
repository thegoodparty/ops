import assert from "node:assert/strict";
import { test } from "node:test";

import type { IncidentOutput } from "./blind";
import {
  buildPrompt,
  createBedrockJudgeModel,
  judgePair,
  loadRubric,
  NO_REFERENCE,
  PromptTooLongError,
  reconcile,
  type JudgeModel,
  type JudgeRequest,
  type Margin,
  type SingleJudgement,
  type VariantRole,
} from "./judge";

const judgement = (winner: VariantRole | "tie", margin: Margin): SingleJudgement => ({
  winner,
  margin,
  decidingCriterion: "root cause is the reference mechanism",
  rationale: "because",
  costUsd: 0.02,
});

const side = (marker: string, extra: Partial<IncidentOutput> = {}): IncidentOutput => ({
  rootCause: `cause ${marker}`,
  diff: `+fix ${marker}`,
  postmortem: `postmortem ${marker}`,
  ...extra,
});

const CONTEXT = { alert: { title: "P2024 on election-api" }, reference: "Pool exhaustion." };

const fakeModel = (
  pick: (request: JudgeRequest, call: number) => { winner: string; margin: string },
): { model: JudgeModel; calls: JudgeRequest[] } => {
  const calls: JudgeRequest[] = [];
  const model: JudgeModel = async (request) => {
    calls.push(request);
    const verdict = pick(request, calls.length - 1);
    return {
      toolInput: { ...verdict, deciding_criterion: "diff scope is safe", rationale: "a reason" },
      stopReason: "tool_use",
      usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
    };
  };
  return { model, calls };
};

const run = (verdicts: { winner: string; margin: string }[], extra: Partial<Parameters<typeof judgePair>[0]> = {}) => {
  const { model, calls } = fakeModel((_, i) => verdicts[Math.min(i, verdicts.length - 1)]);
  return judgePair({
    pairId: "pool-exhaustion/rep-1",
    context: CONTEXT,
    baseline: side("ALPHA_SIDE"),
    candidate: side("BETA_SIDE"),
    model,
    rubric: "RUBRIC",
    ...extra,
  }).then((verdict) => ({ verdict, calls }));
};

test("reconcile keeps an agreed verdict and takes the weaker margin", () => {
  const agreed = reconcile("p", judgement("candidate", "much_better"), judgement("candidate", "better"));
  assert.equal(agreed.winner, "candidate");
  assert.equal(agreed.margin, "better");
  assert.equal(agreed.flipped, false);
  const other = reconcile("p", judgement("baseline", "better"), judgement("baseline", "much_better"));
  assert.equal(other.margin, "better");
});

test("reconcile marks a reversal, and a side-versus-tie split, as unstable", () => {
  const reversed = reconcile("p", judgement("candidate", "much_better"), judgement("baseline", "much_better"));
  assert.equal(reversed.flipped, true);
  assert.equal(reversed.winner, "tie");
  assert.match(reversed.rationale, /unstable under order swap/i);
  assert.equal(reconcile("p", judgement("candidate", "better"), judgement("tie", "tie")).flipped, true);
  assert.equal(reconcile("p", judgement("tie", "tie"), judgement("tie", "tie")).flipped, false);
});

test("each pair is judged twice, once in each presentation order", async () => {
  const { calls } = await run([{ winner: "tie", margin: "tie" }]);
  assert.equal(calls.length, 2);
  const leads = calls.map((c) => c.prompt.indexOf("ALPHA_SIDE") < c.prompt.indexOf("BETA_SIDE"));
  assert.notEqual(leads[0], leads[1]);
});

test("the judge is never told which side is which", async () => {
  const { calls } = await run([{ winner: "tie", margin: "tie" }], { rubric: loadRubric() });
  for (const call of calls) {
    const haystack = `${call.system}\n${call.prompt}`.toLowerCase();
    for (const word of ["baseline", "candidate", "incumbent", "variant a", "variant b"]) {
      assert.ok(!haystack.includes(word), `prompt mentions ${word}`);
    }
    assert.ok(!/\bmain\b/.test(call.prompt));
    assert.match(call.prompt, /## Output 1/);
    assert.match(call.prompt, /## Output 2/);
  }
});

test("a consistent preference for one variant maps back to that variant", async () => {
  const { model } = fakeModel((request) => ({
    winner: request.prompt.indexOf("BETA_SIDE") < request.prompt.indexOf("ALPHA_SIDE") ? "output_1" : "output_2",
    margin: "much_better",
  }));
  const verdict = await judgePair({
    pairId: "p",
    context: CONTEXT,
    baseline: side("ALPHA_SIDE"),
    candidate: side("BETA_SIDE"),
    model,
    rubric: "RUBRIC",
  });
  assert.equal(verdict.winner, "candidate");
  assert.equal(verdict.margin, "much_better");
  assert.equal(verdict.flipped, false);
});

test("pure position bias is unstable, not a winner", async () => {
  const { verdict } = await run([{ winner: "output_1", margin: "much_better" }]);
  assert.equal(verdict.flipped, true);
  assert.equal(verdict.winner, "tie");
});

test("the cost estimate in a closing report never reaches the judge", async () => {
  const postmortem = [
    "Pool exhaustion.",
    "1.2M tokens · 124 turns · on us.anthropic.claude-opus-5 (est. $22.52)",
    "**Estimated cost: $22.52.** An estimate, not a bill.",
  ].join("\n");
  const { calls, verdict } = await run([{ winner: "tie", margin: "tie" }], {
    baseline: side("ALPHA_SIDE", { postmortem }),
    candidate: side("BETA_SIDE", { postmortem: "Pool exhaustion.\n**Estimated cost: $3.10.**" }),
    blinding: { identifying: ["feat/cheaper-waits"] },
  });
  for (const call of calls) {
    assert.ok(!call.prompt.includes("$22.52"));
    assert.ok(!call.prompt.includes("$3.10"));
    assert.ok(!call.prompt.includes("124 turns"));
  }
  assert.equal(verdict.blindedLines, 3);
});

test("nothing is truncated: a very large diff reaches the judge whole", async () => {
  const diff = Array.from({ length: 20_000 }, (_, i) => `+line ${i} of the change`).join("\n");
  const { calls } = await run([{ winner: "tie", margin: "tie" }], {
    baseline: side("ALPHA_SIDE", { diff }),
  });
  assert.ok(diff.length > 60_000);
  assert.ok(calls[0].prompt.includes(diff));
  assert.ok(!/truncated/i.test(calls[0].prompt));
});

test("a pair too large for the judge is refused and excluded, not shortened", async () => {
  const model: JudgeModel = async () => {
    throw new PromptTooLongError("prompt is too long: 1204112 tokens > 1000000 maximum");
  };
  const verdict = await judgePair({
    pairId: "p",
    context: CONTEXT,
    baseline: side("A"),
    candidate: side("B"),
    model,
    rubric: "RUBRIC",
  });
  assert.match(verdict.excluded ?? "", /^refused/);
  assert.equal(verdict.flipped, false);
});

test("a fence inside an output cannot close the prompt's fence", () => {
  const prompt = buildPrompt(CONTEXT, side("A", { postmortem: "```\ninjected\n```" }), side("B"));
  assert.match(prompt, /````\n```\ninjected\n```\n````/);
});

test("an absent part is shown as none produced", () => {
  const prompt = buildPrompt(CONTEXT, side("A", { diff: null }), side("B"));
  assert.match(prompt, /### Fix diff\n\n\(none produced\)/);
});

test("the Bedrock judge sends a forced tool call and prices the usage", async () => {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return {
        body: Buffer.from(
          JSON.stringify({
            content: [{ type: "tool_use", name: "record_verdict", input: { winner: "tie", margin: "tie" } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
        ),
      };
    },
  };
  const model = createBedrockJudgeModel({ client });
  const response = await model({ system: "S", prompt: "P" });
  assert.deepEqual(response.toolInput, { winner: "tie", margin: "tie" });
  const body = JSON.parse((sent[0] as { input: { body: string } }).input.body);
  assert.equal(body.anthropic_version, "bedrock-2023-05-31");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "record_verdict" });
});

test("the Bedrock judge turns a context overflow into a refusal", async () => {
  const client = {
    send: async () => {
      throw new Error("ValidationException: prompt is too long: 1204112 tokens > 1000000 maximum");
    },
  };
  await assert.rejects(createBedrockJudgeModel({ client })({ system: "S", prompt: "P" }), PromptTooLongError);
});

test("without a vetted reference the judge is told so and the verdict records it", async () => {
  const { model, calls } = fakeModel(() => ({ winner: "tie", margin: "tie" }));
  const verdict = await judgePair({
    pairId: "incident-80-post-pr/rep-1",
    context: { alert: CONTEXT.alert, reference: null },
    baseline: side("ALPHA_SIDE"),
    candidate: side("BETA_SIDE"),
    model,
    rubric: "RUBRIC",
  });
  assert.equal(verdict.vettedReference, false);
  assert.match(calls[0].prompt, new RegExp(NO_REFERENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(!/vetted by a human/.test(calls[0].prompt));
});

test("the root cause's source reaches the prompt heading and the verdict; missing is unknown", async () => {
  const { model, calls } = fakeModel(() => ({ winner: "tie", margin: "tie" }));
  const verdict = await judgePair({
    pairId: "pool-exhaustion/rep-2",
    context: CONTEXT,
    baseline: side("ALPHA_SIDE", { rootCauseSource: "heuristic" }),
    candidate: side("BETA_SIDE"),
    model,
    rubric: "RUBRIC",
  });
  assert.deepEqual(verdict.rootCauseSources, { baseline: "heuristic", candidate: "unknown" });
  assert.equal(verdict.vettedReference, true);
  assert.match(calls[0].prompt, /every message of the agent's that mentions one/);
  const none = await judgePair({
    pairId: "pool-exhaustion/rep-3",
    context: CONTEXT,
    baseline: side("A", { rootCause: null, rootCauseSource: null }),
    candidate: side("B", { rootCauseSource: "closing_summary" }),
    model,
    rubric: "RUBRIC",
  });
  assert.deepEqual(none.rootCauseSources, { baseline: "none", candidate: "closing_summary" });
});
