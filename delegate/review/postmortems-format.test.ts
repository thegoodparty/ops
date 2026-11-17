import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Lives beside the folder, not in it, so the `delegate/review/*.test.ts` glob in `npm test` runs it.
const dir = join(__dirname, "postmortems");
const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");

describe("post-mortems", () => {
  it("there is at least one", () => assert.ok(files.length > 0));

  for (const f of files) {
    it(`${f} follows the format`, () => {
      const text = readFileSync(join(dir, f), "utf-8");
      const front = /^---\ntitle: (.+)\ndate: (\d{4}-\d{2}-\d{2})\nsource: (https:\/\/\S+)\n---\n/.exec(text);
      assert.ok(front, "front matter with title, date and source");
      assert.ok(f.startsWith(`${front![2]}-`), "file name starts with the date");
      const lessons = /\n## Lessons\n\n((?:- .+\n)+)/.exec(text);
      assert.ok(lessons, "a Lessons section of bullet lines");
      const count = lessons![1].trim().split("\n").length;
      assert.ok(count >= 1 && count <= 6, `1 to 6 lessons, found ${count}`);
      assert.match(text, /\n## Post-mortem\n\n\S/, "the post-mortem, copied from source");
    });

    it(`${f} has no contact details`, () => {
      const text = readFileSync(join(dir, f), "utf-8");
      assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, "an email address");
      assert.doesNotMatch(text, /\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/, "a phone number");
    });
  }
});
