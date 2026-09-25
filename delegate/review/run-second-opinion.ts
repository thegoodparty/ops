import fs from "node:fs";
import { runSecondOpinion } from "./second-opinion";
import type { SecondOpinionResult } from "./types";

const resultFile = process.env.SECOND_OPINION_FILE || "/app/second-opinion.json";

const writeResult = (result: SecondOpinionResult): void => {
  const tmp = `${resultFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, resultFile);
};

const logResult = (result: SecondOpinionResult): void => {
  console.log(
    JSON.stringify({
      service_name: "delegate-reviewer",
      event: "second_opinion_completed",
      status: result.status,
      model: result.model,
      leads: result.leads,
      findings: result.findings.length,
      deep_reviewer_failures: result.deepReviewerFailures,
      scout_failed: result.scoutFailed,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    })
  );
};

const main = async (): Promise<void> => {
  const startedAt = Date.now();
  try {
    const result = await runSecondOpinion();
    writeResult(result);
    logResult(result);
  } catch (err) {
    const failed: SecondOpinionResult = {
      status: "failed",
      model: process.env.SECOND_OPINION_MODEL || "us.openai.gpt-5.6-sol",
      leads: 0,
      findings: [],
      deepReviewersDispatched: 0,
      deepReviewerFailures: 0,
      scoutFailed: false,
      summary: "",
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
    try {
      writeResult(failed);
    } catch {
      // the parent falls back to a Claude-only review when the file is absent
    }
    logResult(failed);
  }
  process.exit(0);
};

void main();
