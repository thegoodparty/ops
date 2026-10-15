import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WORKBENCH_ZONE_NAME } from "./dns";

// The sibling assertion lives in `deploy-infrastructure/agent-swarm.test.ts`,
// which pins `INFRA_ZONE_NAME`. This is the workbench half of the same fact:
// the name the zone is created under is the name the (staged) NS delegation in
// `deploy/` must name, so a drift here is a delegation that never resolves.
describe("workbench zone", () => {
  it("is the delegated subzone the plan names", () => {
    assert.equal(WORKBENCH_ZONE_NAME, "workbench.goodparty.org");
  });
});
