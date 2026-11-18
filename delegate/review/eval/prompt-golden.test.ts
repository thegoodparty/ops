import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

// The pinned hashes live in `prompt-golden.json` rather than inline, so a PR
// that deliberately changes a prompt has a documented way to move them:
//
//     UPDATE_GOLDEN=1 npx tsx --test delegate/review/eval/prompt-golden.test.ts
//
// and then read the diff, because a hash moving is a prompt moving. Without a
// regenerate path this table would fail every future PR that touches the
// reviewer's prompt or adds a scenario, with no way to say "yes, on purpose"
// short of hand-editing 33 rows — which is how a pin becomes a rubber stamp.
type Golden = Record<string, { review: string; chars: number; selector: string }>;

const GOLDEN_PATH = join(__dirname, "prompt-golden.json");
const GOLDEN: Golden = (
  JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as { cases: Golden }
).cases;

// Set only by the regeneration command above; never in CI.
const UPDATING = process.env.UPDATE_GOLDEN === "1";

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

const manifestIds = (): string[] =>
  [
    ...new Set(
      (
        JSON.parse(
          readFileSync(join(__dirname, "..", "..", "review", "eval", "scenarios.json"), "utf-8"),
        ) as { id: string }[]
      ).map((c) => c.id),
    ),
  ].sort();

test("every recorded bundle builds the prompts it built before the contract changed", async () => {
  // With UPDATE_GOLDEN=1 this rewrites the file instead of asserting, so a PR
  // that changes a prompt on purpose has a way to record it. It recomputes
  // every case, including ones not yet pinned, so adding a scenario and
  // regenerating is one step.
  const computed: Golden = {};
  for (const id of manifestIds()) {
    const { prompt, selectorPrompts } = await reviewPromptFor(id);
    // The stand-in never picks anything, so every case takes exactly one call;
    // the second prompt is only built when something was picked.
    assert.equal(selectorPrompts.length, 1, `${id}: selection prompt count changed`);
    computed[id] = {
      review: digest(prompt),
      chars: prompt.length,
      selector: digest(selectorPrompts[0]),
    };
  }

  if (UPDATING) {
    const existing = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      GOLDEN_PATH,
      `${JSON.stringify({ ...existing, cases: computed }, null, 2)}\n`,
    );
    console.log(`updated ${GOLDEN_PATH}: ${Object.keys(computed).length} case(s)`);
    return;
  }

  // The pinned table must cover exactly the manifest: a new scenario with no
  // pinned row would otherwise be silently unasserted.
  assert.deepEqual(Object.keys(GOLDEN).sort(), manifestIds());

  for (const [id, expected] of Object.entries(GOLDEN)) {
    const actual = computed[id];
    assert.equal(actual.chars, expected.chars, `${id}: prompt length changed`);
    assert.equal(actual.review, expected.review, `${id}: prompt bytes changed`);
    assert.equal(actual.selector, expected.selector, `${id}: selection prompt bytes changed`);
  }
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
