import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WORKBENCH_STACK_NAME,
  WORKBENCH_ZONE_DELEGATION_NAME,
  WORKBENCH_ZONE_NAME_SERVERS_OUTPUT,
} from "./components/workbench-zone-delegation";
import { WORKBENCH_ZONE_NAME } from "../deploy-workbench/dns";

describe("workbench zone delegation", () => {
  // A delegation that names a different zone than the one the workbench stack
  // creates is the failure that reads as an ACM validation problem, so the
  // two literals are asserted equal rather than left to review.
  it("delegates the name the workbench zone creates", () => {
    assert.equal(WORKBENCH_ZONE_NAME, "workbench.goodparty.org");
    assert.equal(WORKBENCH_ZONE_DELEGATION_NAME, WORKBENCH_ZONE_NAME);
  });

  it("reads the name servers from the workbench stack output", () => {
    assert.equal(WORKBENCH_STACK_NAME, "organization/workbench/main");
    assert.equal(WORKBENCH_ZONE_NAME_SERVERS_OUTPUT, "workbenchZoneNameServers");
  });
});
