// What a question with buttons looks like on the wire, and what it refuses to
// build. The invariant under all of it: the message is still a readable,
// answerable question with the blocks thrown away.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHOICE_ACTION_PREFIX,
  CHOICE_BLOCK_ID,
  MAX_CHOICE_LABEL_CHARS,
  MAX_CHOICE_OPTIONS,
  choiceProblem,
  renderChoiceQuestion,
  type SlackBlock,
} from "./blocks";

const buttons = (blocks: readonly SlackBlock[]) => {
  const actions = blocks.find((block) => block.type === "actions");
  assert.ok(actions && actions.type === "actions", "an actions block is posted");
  return actions.elements;
};

describe("what cannot be rendered", () => {
  test("one option is not a choice", () => {
    assert.match(choiceProblem(["Roll back"]) ?? "", /at least two/);
  });

  test("more options than fit a thread on a phone", () => {
    const many = Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => `option ${i}`);
    assert.match(choiceProblem(many) ?? "", /at most/);
  });

  test("a label past Slack's own cap, which would fail the post", () => {
    const long = "x".repeat(MAX_CHOICE_LABEL_CHARS + 1);
    assert.match(choiceProblem(["Roll back", long]) ?? "", /longer than/);
  });

  test("an empty label", () => {
    assert.match(choiceProblem(["Roll back", "   "]) ?? "", /empty/);
  });

  // The label is the answer, so two of them leave the agent unable to say
  // which was pressed.
  test("two labels that read the same", () => {
    assert.match(choiceProblem(["Roll back", "roll back"]) ?? "", /same label/);
  });

  test("two usable options are fine", () => {
    assert.equal(choiceProblem(["Roll back", "Wait for the next deploy"]), null);
  });
});

describe("the rendered question", () => {
  const question = renderChoiceQuestion(
    "The fix is merged. **Roll back now** or wait?",
    ["Roll back", "Wait for the next deploy"],
  );

  test("carries a text fallback, or every notification reads as broken", () => {
    assert.ok(question.text.includes("Roll back now"), "the question is in the fallback");
  });

  test("lists the options in prose as well as on the buttons", () => {
    assert.ok(question.text.includes("1. Roll back"));
    assert.ok(question.text.includes("2. Wait for the next deploy"));
  });

  test("says out loud that typing still works", () => {
    assert.match(question.text, /reply in this thread/i);
    const context = question.blocks.find((block) => block.type === "context");
    assert.ok(context && context.type === "context");
    assert.match(context.elements[0].text, /reply in this thread/i);
  });

  test("converts the Markdown the model wrote, in the section and the fallback", () => {
    const section = question.blocks.find((block) => block.type === "section");
    assert.ok(section && section.type === "section");
    assert.ok(section.text.text.includes("*Roll back now*"), "mrkdwn, not Markdown");
    assert.ok(!section.text.text.includes("**"));
  });

  test("a button carries the label it will send back", () => {
    const elements = buttons(question.blocks);
    assert.equal(elements.length, 2);
    assert.equal(elements[0].value, "Roll back");
    assert.equal(elements[1].value, "Wait for the next deploy");
  });

  test("every action id is prefixed, so a foreign app's click is not ours", () => {
    for (const element of buttons(question.blocks)) {
      assert.ok(element.action_id.startsWith(CHOICE_ACTION_PREFIX));
    }
    const actions = question.blocks.find((block) => block.type === "actions");
    assert.ok(actions && actions.type === "actions");
    assert.equal(actions.block_id, CHOICE_BLOCK_ID);
  });

  test("nothing is posted ahead of the buttons for a question of any sane size", () => {
    assert.deepEqual(question.lead, []);
  });
});

describe("escaping", () => {
  const question = renderChoiceQuestion("Which one? <not-an-entity>", [
    "Drop & recreate",
    "Leave it",
  ]);

  test("a label renders and comes back exactly as the agent wrote it", () => {
    const [first] = buttons(question.blocks);
    // plain_text is not parsed for Slack markup, so escaping it only puts a
    // literal &amp; on the button face and lengthens what the cap was measured on.
    assert.equal(first.text.text, "Drop & recreate");
    assert.equal(first.value, "Drop & recreate");
  });

  test("a label the cap accepts is still within the cap once rendered", () => {
    // The whole point of the cap: what Slack measures is what goes on the
    // wire. Rendered longer, chat.postMessage refuses the post -- and refuses
    // it again on every resume, because the question never changes.
    const atCap = `${"&".repeat(MAX_CHOICE_LABEL_CHARS - 1)}x`;
    assert.equal(choiceProblem(["Leave it", atCap]), null);
    const [, second] = buttons(renderChoiceQuestion("Which one?", ["Leave it", atCap]).blocks);
    assert.equal(second.text.text.length, MAX_CHOICE_LABEL_CHARS);
  });

  test("the numbered fallback list is still escaped, because it is mrkdwn", () => {
    assert.match(question.text, /1\. Drop &amp; recreate/);
  });

  test("a stray angle bracket in the question cannot eat the message", () => {
    const section = question.blocks.find((block) => block.type === "section");
    assert.ok(section && section.type === "section");
    assert.ok(section.text.text.includes("&lt;not-an-entity&gt;"));
  });
});

describe("a question too long for one message", () => {
  const question = renderChoiceQuestion(`${"word ".repeat(1200)}so, which?`, [
    "Yes",
    "No",
  ]);

  test("posts its front half as plain text and keeps the buttons on the end", () => {
    assert.ok(question.lead.length >= 1, "the overflow goes out ahead of it");
    const section = question.blocks.find((block) => block.type === "section");
    assert.ok(section && section.type === "section");
    assert.ok(
      section.text.text.includes("so, which?"),
      "the buttons sit under the part that ends in the question",
    );
    assert.ok(section.text.text.length <= 3000, "a section block is capped at 3,000");
  });
});
