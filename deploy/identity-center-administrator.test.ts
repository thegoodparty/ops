import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// `permissionSets` is private to the component, and step 2 of
// `docs/break-glass.md` is scoped to changing one field in it, so this reads
// the source rather than adding an export just for the test. The duration is
// the whole point of the change: without this, a revert to a longer session is
// invisible until someone notices an admin session outliving its grant.
const source = fs.readFileSync(
  path.resolve(__dirname, "components/identity-center.ts"),
  "utf8",
);

describe("AdministratorAccess session duration", () => {
  // `PT1H` is the floor Identity Center allows, and it bounds every Admins
  // session, standing member or JIT grant alike. Removing a membership does
  // not end an open session, so the set's duration is the outer bound on the
  // escalation window.
  it("is the one-hour floor Identity Center allows", () => {
    const match = source.match(
      /name: "AdministratorAccess",\s*sessionDuration: "([^"]+)"/,
    );
    assert.equal(match?.[1], "PT1H");
  });
});
