import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { encodable, renderReportPdf } from "./pdf";

/**
 * A real `renderReportDocument` output, copied rather than generated so the
 * golden hash below changes only when the PDF layout does, not when the
 * report's wording does. Every table the report carries, a fenced block, a
 * token too long for any line, and characters outside WinAnsi.
 */
const FIXTURE = `# Incident 10

gp-api 5xx rate above 2% | with a pipe

Closed 2026-09-27 12:00:00 UTC · written by BugBoss.

## At a glance

| | |
| --- | --- |
| Status | CLOSED |
| Users impacted | 1,240 |
| Time to detect | 10m |
| Time to resolve | 1h |
| Open to closed | 2h |
| First signal | 2026-09-27 10:00:00 UTC |
| Resolved | 2026-09-27 11:00:00 UTC |
| Closed | 2026-09-27 12:00:00 UTC |
| Signals attached | 1 (grafana) |
| Incidents merged in | 0 |
| Pull requests | 1 (1 merged) |
| Agent launches | 2 |
| On call at open | U-ONCALL |
| Recurrence of | — |

## Root cause

The connection pool saturated after the <prod> deploy.

## Post-mortem

### Timeline

- 10:00 impact began.
- 10:05 alert fired → agent launched.
  - nested detail

### Five whys

1. The pool saturated.
2. Because **max** was _25_ and \`idle\` was 0.

> Quoted from the deploy log.

\`\`\`ts
const pool = new Pool({ max: 25 }); // a line that is long enough to wrap inside the code block because it keeps going and going
\`\`\`

Token: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-end

---

See [the runbook](https://example.com/runbook) — ≥ 3 retries, łódź 🎉.

## Impact

**1,240 users impacted.**

Measured by:

\`\`\`
sum(rate(errors))
\`\`\`

## Resolution

Errors stopped at 11:02; the alert cleared.

- https://github.com/thegoodparty/omni/pull/42 — merged

## Signals

| Source | Kind | Title | Opened | Closed | Explained |
| --- | --- | --- | --- | --- | --- |
| grafana | alert | gp-api 5xx rate above 2% \\| with a pipe | 2026-09-27 10:00:00 UTC | 2026-09-27 11:00:00 UTC | yes |

## What people did

| When | Who | What | Why |
| --- | --- | --- | --- |
| 2026-09-27 10:02:00 UTC | U-SWAIN | merge | same connection pool as inc-9 |

## Agent run

| | |
| --- | --- |
| Model | us.anthropic.claude-opus-5 |
| Launches | 2 |
| Turns | 14 |
| Input tokens | 3,000 |
| Output tokens | 1,200 |
| Cache read | 100,000 |
| Cache write | 2,000 |
| Cache write (1h) | 1,500 |
| Total tokens | 106,200 (106.2k) |

**Estimated cost: $3.76.** An estimate, not a bill — it is arithmetic over the tokens above at the prices we held while this ran, and nothing here ever sees an invoice. Tokens and the model id are the record, because they re-price correctly after a rate change and a stored dollar figure would not.

`;

/**
 * The text each page draws, one entry per text operation, read out of an
 * uncompressed render. Standard-font text is written as hex of WinAnsi bytes
 * inside TJ arrays, with kerning numbers between the pieces.
 */
const drawnText = (pdf: Buffer): string[] =>
  [...pdf.toString("latin1").matchAll(/\[((?:<[0-9a-f]*>|\s|-?[\d.]+)*)\] TJ/g)].map((op) =>
    [...op[1].matchAll(/<([0-9a-f]*)>/g)]
      .map((hex) => Buffer.from(hex[1], "hex").toString("latin1"))
      .join(""),
  );

const pageCount = (pdf: Buffer): number =>
  (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

describe("the closing report as a PDF", () => {
  it("is a function of its input, byte for byte", async () => {
    const first = await renderReportPdf(FIXTURE);
    const second = await renderReportPdf(FIXTURE);

    assert.equal(first.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(first.equals(second), "two renders of one report differ");
    // Pinned so a layout change is a reviewed change. Regenerate it on purpose
    // when the layout is meant to move, never to make this pass.
    assert.equal(
      createHash("sha256").update(first).digest("hex"),
      "8ec580b0aedbb47a7350afb6f5b4eb73552d98eb94eeb1553c717184fbdcc1b0",
    );
  });

  it("draws every table cell, the code block and the whole long token", async () => {
    const lines = drawnText(await renderReportPdf(FIXTURE, { compress: false }));
    const all = lines.join("\n");

    for (const text of [
      "At a glance",
      "Users impacted",
      "1,240",
      "Recurrence of",
      "Signals",
      "Explained",
      "same connection pool as inc-9",
      "Agent run",
      "Cache write (1h)",
      "106,200 (106.2k)",
      "sum(rate(errors))",
      "const pool = new Pool({ max: 25 });",
    ]) {
      assert.ok(all.includes(text), `missing: ${text}`);
    }
    // Wrapped, not cut: the token spans several lines and every character of
    // it is drawn somewhere.
    const token = `${"a".repeat(172)}-end`;
    assert.ok(lines.join("").includes(token), "the long token lost characters");
    assert.ok(!lines.some((line) => line.includes(token)), "the long token was not wrapped");
    // The code line wraps too, and keeps every character across the break.
    assert.ok(
      lines.join("").includes("wrap inside the code block because it keeps going and going"),
    );
  });

  it("spells what WinAnsi cannot draw instead of drawing the wrong glyph", async () => {
    const all = drawnText(await renderReportPdf(FIXTURE, { compress: false })).join("\n");

    assert.ok(all.includes("alert fired -> agent launched"));
    assert.ok(all.includes(">= 3 retries, l\u00f3dz ?."));
    assert.equal(encodable("a→b ≥ ł 中 🎉 “q” — é"), "a->b >= l ? ? “q” — é");
  });

  it("continues a long table on the next page, header and all", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| row ${i} | value ${i} |`);
    const markdown = ["## Signals", "", "| Name | Value |", "| --- | --- |", ...rows].join("\n");
    const pdf = await renderReportPdf(markdown, { compress: false });
    const lines = drawnText(pdf);

    const pages = pageCount(pdf);
    assert.ok(pages > 1, "200 rows fit on one page");
    assert.ok(lines.includes("row 199"), "the last row was cut");
    assert.ok(lines.includes("value 199"));
    assert.equal(lines.filter((line) => line === "Name").length, pages, "the header repeats per page");
  });

  it("paginates a code block longer than a page rather than cutting it", async () => {
    const code = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
    const pdf = await renderReportPdf(["```", code, "```"].join("\n"), { compress: false });
    const lines = drawnText(pdf);

    assert.ok(pageCount(pdf) > 1);
    assert.ok(lines.includes("line 0"));
    assert.ok(lines.includes("line 149"));
  });
});
