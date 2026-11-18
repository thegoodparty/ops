import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReviewPrompt } from "../../agents/pr-reviewer";
import { promptDiff } from "../prompt-diff";
import { POSTMORTEM_SELECTOR, selectPostmortems } from "../postmortems";
import { BundleSchema } from "../schema";
import { agentEnv } from "../run";

// "Behaviour-identical" is the claim S2 of
// `docs/delegate-harness-migration.md` makes, and a claim about a refactor is
// worth nothing until something fails when it stops being true. This is that
// something: the review prompt for every recorded bundle, hashed, pinned to
// the value the code produced *before* the contract changed.
//
// What it compares, precisely: for each case in `eval/scenarios.json`, the
// post-mortem selection prompt (also model input, and also built by this tree)
// and the review prompt, in the shape a replay builds them — post-mortems
// selected, a diff too large for the first message moved to a file — with the
// per-run random parts fixed. The diff boundary token is 24 random hex bytes on
// every run, so it is replaced with a literal; the checkout path is a per-run
// temp directory, so it is replaced too. Everything else is the real bytes.
//
// The prompt takes its post-mortems from `selectPostmortems`, so a change to
// what that pass is asked, or to the review prompt, fails here. It does not
// cover the harness's own rendering of the options object; that is
// `framework/agent.test.ts`'s job.

// The review prompt, and the one selection prompt that follows it, for each
// case: sha256/16 of the boundary-normalised text, and its length. Computed
// from `main` at a8b5108, the commit S2 branched from, so a difference is this
// branch's doing and not a coincidence.
const GOLDEN: [id: string, promptHash: string, promptChars: number][] = [
  ["gp-data-platform-1162-zip-leading-zeros", "d0fb27c99f432dda", 23826],
  ["gp-data-platform-1181-one-carried-one-new", "ab56a47d86a49717", 90743],
  ["gp-data-platform-1184-off-list-is-false", "4ccf7a37ec9054e3", 50071],
  ["gp-data-platform-1285-overlapping-age-bands", "f938b4ca41deb5bf", 56641],
  ["gp-marketing-418-takedown-bypass", "8f059c88de4f473e", 22886],
  ["gp-marketing-424-metadata-raw-name", "fca376e1e4be0009", 32781],
  ["gp-marketing-443-four-priors-all-fixed", "79448f87889d6249", 45802],
  ["omni-2453-proposal-key-race", "fdcdc24f30d48c08", 11244],
  ["omni-2461-fenced-json", "78afc0b472ee3e7f", 44075],
  ["omni-2461-prose-checking-prior", "d46e90fa088f989f", 44557],
  ["omni-2474-dependabot-major-bump", "20cb0ad7a964620a", 38319],
  ["omni-2506-greeting-without-name", "7d20854d9cf4d0b9", 29463],
  ["omni-2522-two-priors-fixed", "b372e49dbdaf3004", 10869],
  ["omni-2581-three-priors-oversized-diff", "5cfe7b170f1d870d", 21222],
  ["omni-2589-draft-backstop-asymmetry", "2ced4c830bf23aeb", 27808],
  ["omni-2655-last-attempt-strands-purchase", "78dfd58fd97ec49d", 7446],
  ["omni-2655-one-fixed-one-open", "d2858a7ed66dd07a", 17608],
  ["omni-2671-ecr-public-login", "c458f346a8db3db4", 15775],
  ["omni-2679-starlette-background-task", "e64aabedacdfa028", 57622],
  ["omni-2701-docs-addition", "8c7aa8c20ac434cb", 5407],
  ["omni-2709-double-counted-respondents", "c3516d37c6113473", 11492],
  ["omni-2824-cancel-without-claim", "725d9fa964eb43aa", 5866],
  ["omni-2830-cutoff-general-only", "db2ecc797620d96f", 18360],
  ["omni-3154-reconcile-window-misses-stale", "7e55a179c2521897", 10264],
  ["omni-3276-self-set-internal-email", "0730cc13127dbc80", 12814],
  ["ops-244-prose-instead-of-json", "20cbee873dbd130a", 66070],
  ["ops-255-workflow-shell-injection", "07193008d62269cf", 45849],
  ["ops-271-re-raised-without-link", "c6765f6db188895c", 57546],
  ["ops-302-mangled-prior-id", "58eef166336e1ac3", 13450],
  ["ops-302-two-priors-still-open", "c2d5d6fb3bd401fc", 13450],
  ["ops-343-rolling-deploy-two-gateways", "69138955251005be", 67853],
  ["ops-377-config-arn-never-redeploys", "c9f959447532027b", 69613],
  ["ops-379-alb-kills-slow-boot", "87f0cce3329452dd", 14987],
];

const SCENARIOS = join(__dirname, "scenarios");

const normalise = (text: string): string =>
  text
    .replace(/boundary="[0-9a-f]{24}"/g, 'boundary="TOKEN"')
    .replace(/\/tmp\/delegate-prompt-[0-9a-z-]+/g, "/CHECKOUT");

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

const reviewPromptFor = async (id: string) => {
  const record = JSON.parse(
    readFileSync(join(SCENARIOS, `${id}.record.json`), "utf-8"),
  ) as { bundle: unknown };
  const bundle = BundleSchema.parse(record.bundle);
  // The post-mortems a case is shown are chosen by a model call, so the pass is
  // given a deterministic stand-in that keeps nothing. Its prompt is still the
  // pass's own prompt, which is why it is hashed rather than skipped: the
  // selection ask is model input too.
  const selectorPrompts: string[] = [];
  const postmortems = await selectPostmortems(bundle, {
    redact: true,
    ask: async (prompt) => {
      selectorPrompts.push(normalise(prompt));
      return '{"ids":[]}';
    },
  });
  // As a replay builds it: a diff too large for the first message is a file in
  // the checkout, and everything else is inline.
  const pd = promptDiff(bundle.diff);
  const prompt = buildReviewPrompt(bundle, {
    diffPath: pd.oversized ? "/tmp/delegate-prompt-checkout/diff.patch" : undefined,
    boundary: "0123456789abcdef01234567",
    postmortems,
  });
  return { prompt: normalise(prompt), selectorPrompts };
};

test("the post-mortem selector's config is what its prompt assumes", () => {
  // A guard against the prompt test passing while the selector quietly gained
  // tools or a different model: both are model input the hashes above cannot
  // see, because they are config rather than prompt text.
  assert.equal(POSTMORTEM_SELECTOR.model, "claude-sonnet-5-5");
  assert.deepEqual(POSTMORTEM_SELECTOR.tools, {});
  assert.equal(POSTMORTEM_SELECTOR.maxTurns, 2);
});

test("every recorded bundle builds the review prompt it built before the contract changed", async () => {
  const seen = new Set<string>();
  for (const [id, promptHash, promptChars] of GOLDEN) {
    seen.add(id);
    const { prompt, selectorPrompts } = await reviewPromptFor(id);
    assert.equal(prompt.length, promptChars, `${id}: prompt length changed`);
    assert.equal(digest(prompt), promptHash, `${id}: prompt bytes changed`);
    // The stand-in never picks anything, so every case takes the same single
    // selection call. Asserting the count keeps a second call from appearing
    // unnoticed: the second prompt is only built when something was picked.
    assert.equal(selectorPrompts.length, 1, `${id}: selection prompt count changed`);
  }
  assert.equal(seen.size, GOLDEN.length);
});

test("the golden table covers every recorded scenario", () => {
  // Otherwise a new scenario is added and this suite says nothing about it.
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "review", "eval", "scenarios.json"), "utf-8"),
  ) as { id: string }[];
  assert.deepEqual(
    [...new Set(manifest.map((c) => c.id))].sort(),
    GOLDEN.map(([id]) => id).sort(),
  );
});

test("the prompt a case builds is the same one agentEnv and the guards sit in front of", async () => {
  // The review prompt is only half the contract: `run.ts` hands
  // `buildReviewPrompt(...)` to `runAgent` with `agentEnv()` and
  // `pathGuardHook(...)`, and S2 changes neither. This pins the wiring the
  // prompt assertion assumes, so a refactor that dropped the guard or widened
  // the env would not read as a pass.
  assert.deepEqual(
    Object.keys(agentEnv({ PATH: "/usr/bin", GITHUB_TOKEN: "ghs", ANTHROPIC_API_KEY: "k" })).sort(),
    ["ANTHROPIC_API_KEY", "PATH"],
  );
  const runSource = readFileSync(join(__dirname, "..", "run.ts"), "utf-8");
  assert.match(runSource, /toolCallGuards: \[pathGuardHook\(reviewDir\)\]/);
  assert.match(runSource, /env: agentEnv\(\)/);
});
