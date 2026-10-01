// Bedrock constants with no imports, deliberately.
//
// `deploy/components/bugboss.ts` reads from here, and the Pulumi program is
// compiled by ts-node from `deploy/` with no tsconfig of its own -- so it
// gets ts-node's default `moduleResolution: node`, not the NodeNext the root
// tsconfig sets. Under that setting a package export-map subpath does not
// resolve, and `./model.ts` has one (`@earendil-works/pi-ai/providers/all`),
// so importing that file from the Pulumi program fails `pulumi preview` with
// a TS2307 that never shows up in `tsc --noEmit`.
//
// A file with no imports at all cannot acquire that problem later.

/**
 * The cross-region inference profile the incident agent runs on by default,
 * overridden at runtime by `BUGBOSS_MODEL_ID`.
 *
 * Shared with the deploy so the application inference profile wraps the
 * model the agent actually defaults to. Hardcoding it in both places would
 * let the two drift, and the symptom of that drift is a Cost Explorer line
 * that quietly stops appearing.
 */
export const DEFAULT_MODEL_ID = "us.anthropic.claude-opus-5";

/**
 * The stage-goal evaluator's model, overridden by `BUGBOSS_GOAL_MODEL_ID`.
 * Small and fast on purpose, as Claude Code's /goal evaluator is: it reads a
 * goal and the agent's recent transcript and answers with a verdict, at every
 * gate and every merge ask.
 */
export const DEFAULT_GOAL_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
