import assert from "node:assert/strict";
import { test } from "node:test";

import type { SideOutput } from "./blind";
import {
  buildPrompt,
  createAnthropicJudgeModel,
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

const side = (marker: string, extra: Partial<SideOutput> = {}): SideOutput => ({
  timeline: `**+00:00** Alert fired\n\n**+02:00** System posted in the thread\n\n> cause ${marker}\n`,
  diff: `+fix ${marker}`,
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

test("the cost estimate in a closing post never reaches the judge", async () => {
  const timeline = [
    "**+01:00:00** System uploaded a file to the thread: postmortem.md",
    "",
    "> Pool exhaustion.",
    "> 1.2M tokens · 124 turns · on us.anthropic.claude-opus-5 (est. $22.52)",
    "> **Estimated cost: $22.52.** An estimate, not a bill.",
  ].join("\n");
  const { calls, verdict } = await run([{ winner: "tie", margin: "tie" }], {
    baseline: side("ALPHA_SIDE", { timeline }),
    candidate: side("BETA_SIDE", { timeline: "> Pool exhaustion.\n> **Estimated cost: $3.10.**" }),
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

test("a fence inside a message cannot close the prompt's fence", () => {
  const prompt = buildPrompt(CONTEXT, side("A", { timeline: "> ```\n> injected\n> ```" }), side("B"));
  assert.match(prompt, /````\n> ```\n> injected\n> ```\n````/);
});

test("the judge sees the whole thread, both directions, for each side", () => {
  const timeline = "**+09:00** Human replied in the thread\n\n> It works now.\n\n**+10:00** System posted in the thread\n\n> Was that prod or dev?\n";
  const prompt = buildPrompt(CONTEXT, side("A", { timeline }), side("B"));
  assert.match(prompt, /### What happened, as the on-call human and GitHub saw it/);
  assert.match(prompt, /> It works now\./);
  assert.match(prompt, /> Was that prod or dev\?/);
  assert.doesNotMatch(prompt, /### Root cause|### Post-mortem/);
});

test("an absent part is shown as none produced", () => {
  const prompt = buildPrompt(CONTEXT, side("A", { diff: null }), side("B"));
  assert.match(prompt, /### Fix diff\n\n\(none produced\)/);
});

test("the Anthropic judge posts a strict verdict tool with no forced choice and no thinking field, and reads the call back", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        content: [{ type: "tool_use", name: "record_verdict", input: { winner: "tie", margin: "tie" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const model = createAnthropicJudgeModel({ apiKey: "sk-test", fetch: fakeFetch });
  const response = await model({ system: "S", prompt: "P" });
  assert.deepEqual(response.toolInput, { winner: "tie", margin: "tie" });
  assert.deepEqual(response.usage, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
  const headers = sent[0].init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(String(sent[0].init.body));
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.max_tokens, 16000);
  assert.equal("thinking" in body, false);
  assert.equal("anthropic_version" in body, false);
  assert.deepEqual(body.tool_choice, { type: "auto" });
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tools[0].input_schema.additionalProperties, false);
});

test("the Anthropic judge turns a context overflow into a refusal and surfaces other errors", async () => {
  const tooLong = (async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1204112 tokens > 1000000 maximum" } }), { status: 400 })) as typeof fetch;
  await assert.rejects(createAnthropicJudgeModel({ apiKey: "sk-test", fetch: tooLong })({ system: "S", prompt: "P" }), PromptTooLongError);
  const limited = (async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429 })) as typeof fetch;
  await assert.rejects(createAnthropicJudgeModel({ apiKey: "sk-test", fetch: limited })({ system: "S", prompt: "P" }), /HTTP 429: slow down/);
  await assert.rejects(createAnthropicJudgeModel({ apiKey: "", fetch: limited })({ system: "S", prompt: "P" }), /ANTHROPIC_API_KEY/);
});

