import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTagValue, buildTaskTags } from "./dispatch";

describe("sanitizeTagValue", () => {
  it("replaces the [] in a bot login that ECS rejects", () => {
    // The real trigger: Dependabot PRs dispatched a `dependabot[bot]` author
    // tag, which made RunTask throw "Some tags contain invalid characters".
    assert.equal(sanitizeTagValue("dependabot[bot]"), "dependabot-bot-");
  });

  it("leaves a normal login and the ECS-allowed punctuation untouched", () => {
    assert.equal(sanitizeTagValue("tomer-tgp"), "tomer-tgp");
    // repo full names and SHAs flow through tags too — `/` `_` `.` `:` `@`
    // `+` `=` `-` are all valid and must survive unchanged.
    assert.equal(
      sanitizeTagValue("thegoodparty/gp-data-platform"),
      "thegoodparty/gp-data-platform",
    );
    assert.equal(sanitizeTagValue("a_b.c/d=e+f-g:h@i 1"), "a_b.c/d=e+f-g:h@i 1");
  });

  it("caps values at the 256-char ECS tag limit", () => {
    assert.equal(sanitizeTagValue("x".repeat(300)).length, 256);
  });
});

describe("buildTaskTags", () => {
  it("tags the task as infra so engineer policy cannot mutate it", () => {
    const tags = buildTaskTags({ agent: "pr-reviewer" } as never);
    assert.deepEqual(
      tags.find((t) => t.key === "Environment"),
      { key: "Environment", value: "infra" },
    );
  });

  it("keeps the Project and agent tags", () => {
    const tags = buildTaskTags({ agent: "pr-reviewer" } as never);
    assert.deepEqual(
      tags.find((t) => t.key === "Project"),
      { key: "Project", value: "ops" },
    );
    assert.deepEqual(
      tags.find((t) => t.key === "agent"),
      { key: "agent", value: "pr-reviewer" },
    );
  });

  it("sanitizes metadata values", () => {
    const tags = buildTaskTags({
      agent: "pr-reviewer",
      metadata: { author: "dependabot[bot]" },
    } as never);
    assert.deepEqual(
      tags.find((t) => t.key === "author"),
      { key: "author", value: "dependabot-bot-" },
    );
  });
});
