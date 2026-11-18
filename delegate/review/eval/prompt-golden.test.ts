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

// The review prompt and the selection prompt, per case: sha256/16 of the
// boundary-normalised text, and the review prompt's length. Computed from
// `main` at 6e002e4, the commit this branch merged before the comparison, so a
// difference is this branch's doing and not a coincidence.
// [id, review prompt hash, review prompt length, selector prompt hash] —
// computed from origin/main at 6e002e4 (this branch's base after #549 moved the
// post-mortem folder), so a difference is this branch's doing.
const GOLDEN: [id: string, reviewHash: string, reviewChars: number, selectorHash: string][] = [
  ["gp-data-platform-1162-zip-leading-zeros", "d0fb27c99f432dda", 23826, "0e95505d2dec2a04"],
  ["gp-data-platform-1181-one-carried-one-new", "ab56a47d86a49717", 90743, "321ce7e32c23bcfe"],
  ["gp-data-platform-1184-off-list-is-false", "4ccf7a37ec9054e3", 50071, "fb7564a00fddb326"],
  ["gp-data-platform-1285-overlapping-age-bands", "f938b4ca41deb5bf", 56641, "24a4743bdb03a009"],
  ["gp-marketing-418-takedown-bypass", "8f059c88de4f473e", 22886, "a0744a18fe8d4fdf"],
  ["gp-marketing-424-metadata-raw-name", "fca376e1e4be0009", 32781, "f136524b5b93c86b"],
  ["gp-marketing-443-four-priors-all-fixed", "79448f87889d6249", 45802, "7427deba1d2aa701"],
  ["omni-2453-proposal-key-race", "fdcdc24f30d48c08", 11244, "b6bd118c00b0953d"],
  ["omni-2461-fenced-json", "78afc0b472ee3e7f", 44075, "868faecfbf491689"],
  ["omni-2461-prose-checking-prior", "d46e90fa088f989f", 44557, "07968e276c16f807"],
  ["omni-2474-dependabot-major-bump", "20cb0ad7a964620a", 38319, "f0648bdf23e7e5e9"],
  ["omni-2506-greeting-without-name", "7d20854d9cf4d0b9", 29463, "4cf0ec77de3a19d6"],
  ["omni-2522-two-priors-fixed", "b372e49dbdaf3004", 10869, "8a3e273dd5bb74e2"],
  ["omni-2581-three-priors-oversized-diff", "5cfe7b170f1d870d", 21222, "2edd839a793bdac4"],
  ["omni-2589-draft-backstop-asymmetry", "2ced4c830bf23aeb", 27808, "199c2715bc74eb1a"],
  ["omni-2655-last-attempt-strands-purchase", "78dfd58fd97ec49d", 7446, "928eafffeb2774f4"],
  ["omni-2655-one-fixed-one-open", "d2858a7ed66dd07a", 17608, "bc505fa836bf7b03"],
  ["omni-2671-ecr-public-login", "c458f346a8db3db4", 15775, "14e70118f5f856f3"],
  ["omni-2679-starlette-background-task", "e64aabedacdfa028", 57622, "bd99d6a774cd0d2f"],
  ["omni-2701-docs-addition", "8c7aa8c20ac434cb", 5407, "f0c6f3a675eb31ff"],
  ["omni-2709-double-counted-respondents", "c3516d37c6113473", 11492, "5ced9cd3dee1c983"],
  ["omni-2824-cancel-without-claim", "725d9fa964eb43aa", 5866, "95aafc1b09659d32"],
  ["omni-2830-cutoff-general-only", "db2ecc797620d96f", 18360, "3d90351b761c704c"],
  ["omni-3154-reconcile-window-misses-stale", "7e55a179c2521897", 10264, "14cfbf23aca49e1c"],
  ["omni-3276-self-set-internal-email", "0730cc13127dbc80", 12814, "9cdb471e299b82ec"],
  ["ops-244-prose-instead-of-json", "20cbee873dbd130a", 66070, "1c6315e0f3e19b6b"],
  ["ops-255-workflow-shell-injection", "07193008d62269cf", 45849, "ddbfc6072dd9e473"],
  ["ops-271-re-raised-without-link", "c6765f6db188895c", 57546, "11ff82e8e0056ca7"],
  ["ops-302-mangled-prior-id", "58eef166336e1ac3", 13450, "c016cdcc35642339"],
  ["ops-302-two-priors-still-open", "c2d5d6fb3bd401fc", 13450, "cfe3c744246e3b93"],
  ["ops-343-rolling-deploy-two-gateways", "69138955251005be", 67853, "426229bd82669eb0"],
  ["ops-377-config-arn-never-redeploys", "c9f959447532027b", 69613, "626ca48f1a1b144e"],
  ["ops-379-alb-kills-slow-boot", "87f0cce3329452dd", 14987, "9b6f33aa49b8ade1"],
];

const SCENARIOS = join(__dirname, "scenarios");

// The post-mortem folder is frozen here, at the bytes the hashes below were
// computed from, rather than read from `delegate/review/postmortems/`.
//
// Reading the live folder made this test fail on content rather than on code:
// the selector prompt lists every lesson in the folder, so the weekly sync that
// adds a post-mortem — or any edit to one — moved all 33 hashes and turned
// `npm test` red for a PR that changed no code at all. That is ops#549's
// shape, and it would have made the sync PR the thing that broke the suite.
// A fixture is the same trick `reviewPromptFor` already uses for the model's
// selection: hold everything but the code still.
const POSTMORTEM_FIXTURES = join(__dirname, "prompt-fixtures", "postmortems");

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
    dir: POSTMORTEM_FIXTURES,
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

test("every recorded bundle builds the prompts it built before the contract changed", async () => {
  const seen = new Set<string>();
  for (const [id, promptHash, promptChars, selectorHash] of GOLDEN) {
    seen.add(id);
    const { prompt, selectorPrompts } = await reviewPromptFor(id);
    assert.equal(prompt.length, promptChars, `${id}: prompt length changed`);
    assert.equal(digest(prompt), promptHash, `${id}: prompt bytes changed`);
    // The selection prompt is model input too, and it carries the diff, the
    // title, the body and the lessons, so it is asserted rather than counted.
    // The stand-in never picks anything, so every case takes exactly one call;
    // the second prompt is only built when something was picked.
    assert.equal(selectorPrompts.length, 1, `${id}: selection prompt count changed`);
    assert.equal(digest(selectorPrompts[0]), selectorHash, `${id}: selection prompt bytes changed`);
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
