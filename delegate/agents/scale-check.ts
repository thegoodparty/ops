import { GIT_TOOL_NAMES } from "../review/git-tool";
import type { AgentConfig } from "../framework";
import type { Bundle } from "../review/schema";

// The sizes below describe omni's data and cite omni paths. In any other repo
// the scale check has no sourced N to block on, and it may only block with
// one, so it is not run there.
const SCALE_REPOS = new Set(["thegoodparty/omni"]);

// Sections "Sizes" and "Limits already in code" of omni docs/scale.md at
// 34319d9ed5, as written. Refresh by copying them again; never edit a value here.
export const SCALE_FACTS = `## Sizes

All counts are aggregate. Date read: 2026-11-05.

| What | Value | Source |
| --- | --- | --- |
| Voter rows, \`mart_gp_api.gp_api_voters\` | ~219M | \`docs/features/recommended-lists.md:54\` |
| Largest district, constituents | 23.3M | \`packages/gp-api/src/peopleDb/AGENTS.md:235\` |
| Statewide district, \`constituents\` | ~21.5M | \`packages/gp-api/src/peopleDb/AGENTS.md:421\` |
| Smallest district measured | ~1k | \`packages/gp-api/src/peopleDb/AGENTS.md:235\` |
| Census tracts, statewide North Carolina | 3,003 tracts, 7.4M people | ClickUp post-mortem "2026-11-04 Statewide read freeze" |
| Census tracts, statewide California (largest state) | 9,129 tracts | US Census Bureau, 2020 tract counts |
| Large congressional district (PA-12) | 529,131 registered | \`docs/features/recommended-lists.md:91\` |
| Voters per district, median: state, county, city, school board | TBD (data team) | none in repo |
| Voters per district, largest: county, city, school board | TBD (data team) | none in repo |
| Contacts per campaign: median, p95, max | TBD (data team) | none in repo |
| Contacts per org: median, p95, max | TBD (data team) | none in repo |
| Largest gp-api tables by row count | TBD (data team) | none in repo |
| people-db tables in Databricks, other than \`gp_api_voters\` | TBD (data team) | none in repo |
| Largest saved voter-file filter or list | TBD (data team) | none in repo |
| Largest outreach audience sent | ~82,000 recipients, resolution outran the gateway (INC-101) | \`packages/gp-api/src/vendors/peerly/services/p2pPhoneListUpload.service.ts:849\` |
| CallHub robocall dialing, self-serve tier | 120 calls/min, one campaign at a time | ClickUp post-mortem "2026-11-03 Election Robocall" |
| gp-api ECS task memory, prod / non-prod | 4096 MB / 2048 MB, 1 vCPU | \`packages/gp-api/deploy/components/service.ts:335\` |

## Limits already in code

| Limit | Value | Source |
| --- | --- | --- |
| Audience page size | 1,000 | \`contacts/utils/audienceResolution.util.ts:76\` |
| Audience cap per resolution | 200,000 | \`contacts/utils/audienceResolution.util.ts:77\` |
| Interactive resolution budget | 90 s (gateway gives up at ~120 s) | \`contacts/utils/audienceResolution.util.ts:106\` |
| Peerly phone list recipients | 200,000 (page 1,000) | \`vendors/peerly/services/p2pPhoneListUpload.service.ts:53\` |
| CallHub phonebook numbers | 100,000 (page 1,000) | \`outreach/services/robocallPhonebook.service.ts:24\` |
| Outreach materialization page | 1,000 | \`outreach/services/outreachMaterialization.service.ts:31\` |
| Poll expansion excluded ids | 100,000 | \`outreach/services/outreachServePollExpansion.service.ts:26\` |
| Id filter \`in\` / \`notIn\` | 200,000 each | \`packages/contracts/src/people/PeopleFilters.schema.ts:174\` |
| Precinct filter values | 5,000 | \`packages/contracts/src/people/PeopleFilters.schema.ts:239\` |
| Door-knocking pack rows | 3,000,000 | \`peopleDb/databricks/databricksVoterPack.service.ts:47\` |
| Polygon preview people | 50,000 | \`contacts/services/contacts.service.ts:196\` |
| Contact upload rows | 100,000 | \`packages/contracts/src/contactUploads/ContactUpload.schema.ts:5\` |
| Page size / max offset | 10,000 / 1,000,000 | \`packages/contracts/src/shared/Pagination.schema.ts:9\` |
| Databricks statement bytes / bound params | 16,777,216 / 10,000 | \`peopleDb/databricks/peopleDbxStatement.client.ts:24\` |

Paths without a prefix are under \`packages/gp-api/src/\`.`;

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const NOT_REVIEWED_FOR_SCALE =
  /(\.test\.|\.spec\.|\.d\.ts$|(^|\/)(tests?|__tests__|__mocks__|fixtures|scripts|migrations)\/|(^|\/)test_[^/]*\.py$|\.stories\.)/;

const DB_QUERY =
  /\b(findMany|findFirst|findUnique|createMany|updateMany|deleteMany|upsert|groupBy|aggregate|\$queryRaw\w*|\$executeRaw\w*|executeStatement)\b|\.query\(|\bSELECT\b|\bJOIN\b/;
const LOOP =
  /\bfor\s*\(|\bfor\s+\w+(\s*,\s*\w+)*\s+in\b|\bwhile\s*[(\w]|\.(map|forEach|reduce|filter|flatMap|some|every)\(|Promise\.all(Settled)?\(|\bsum\(|\bsorted\(/;
const PEOPLE_DATA =
  /voter|contact|person|people|tract|district|constituent|audience|recipient/i;
const REQUEST_PATH_FILE = /(controller|\.routes?\.|router|resolver|handler)[^/]*$/i;
const REQUEST_PATH_LINE =
  /@(Get|Post|Put|Patch|Delete)\(|\b(router|app|server)\.(get|post|put|patch|delete|route)\(/;

export type ScaleSignal = "db-query" | "loop-over-people" | "request-path";
export type ScaleTrigger = { path: string; signals: ScaleSignal[] };

const addedLinesByFile = (diff: string): Map<string, string[]> => {
  const files = new Map<string, string[]>();
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const m = section.match(/^diff --git a\/.+? b\/(.+)$/m);
    if (!m) continue;
    const lines = section.split("\n");
    if (lines.some((l) => l === "+++ /dev/null")) continue;
    const added: string[] = [];
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith("@@")) inHunk = true;
      else if (inHunk && l.startsWith("+")) added.push(l.slice(1));
    }
    files.set(m[1], added);
  }
  return files;
};

// Decided from the diff alone, so whether the scale check runs never depends
// on a model's reading of the PR.
export const scaleTriggers = (bundle: Pick<Bundle, "repo" | "diff">): ScaleTrigger[] => {
  if (!SCALE_REPOS.has(bundle.repo)) return [];
  const triggers: ScaleTrigger[] = [];
  for (const [path, added] of addedLinesByFile(bundle.diff)) {
    if (!CODE_FILE.test(path) || NOT_REVIEWED_FOR_SCALE.test(path)) continue;
    const text = added.join("\n");
    const people = PEOPLE_DATA.test(text);
    const signals: ScaleSignal[] = [];
    if (DB_QUERY.test(text)) signals.push("db-query");
    if (people && LOOP.test(text)) signals.push("loop-over-people");
    if (people && (REQUEST_PATH_FILE.test(path) || REQUEST_PATH_LINE.test(text))) {
      signals.push("request-path");
    }
    if (signals.length > 0) triggers.push({ path, signals });
  }
  return triggers;
};

const MAX_LISTED = 25;

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export const buildScaleCheckXml = (triggers: ScaleTrigger[]): string => {
  if (triggers.length === 0) return "";
  const listed = triggers
    .slice(0, MAX_LISTED)
    .map((t) => `${escapeText(t.path)} (${t.signals.join(", ")})`)
    .join("\n");
  const more =
    triggers.length > MAX_LISTED
      ? `\n...and ${triggers.length - MAX_LISTED} more; Grep the diff for the rest.`
      : "";
  return `  <scale_check>
The harness found changed code that queries or iterates over data whose size depends on production volume:
${listed}${more}

In Phase 2, in the same message as the deep-reviewer Task calls, spawn exactly one scale-check subagent, even when the scout returned no leads. Give it this file list and the diff (inline, or the diff file path). It runs once per review, independently of the scout's leads. Treat its findings like a deep-reviewer's, and keep their category "scale". If it returns {"findings":[]}, there is nothing to add.
  </scale_check>
`;
};

export const scaleCheckSubagent: NonNullable<AgentConfig["agents"]>[string] = {
  description:
    "Checks whether changed code breaks at production data sizes. Spawn it only when the bundle contains a <scale_check> element, exactly once, alongside the deep-reviewers.",
  prompt: `You are the scale check in a PR review. You answer one question: does this change break at the data sizes the product really has? You do not review anything else; correctness, security, tests and conventions are other reviewers' jobs, and you emit nothing about them.

## Context

The orchestrator gives you the files the harness flagged and the diff (inline or as a path). The repo is checked out in your working directory at the reviewed head SHA. Use Read, Grep, Glob and the git tools; no commands, no network.

## Production sizes

These are the only sizes you may use. Each N you name must be a row below, quoted with its value. A row marked \`TBD (data team)\` has no number: do not guess one, and do not block on it.

${SCALE_FACTS}

## What to do

1. For each flagged file, find the new or changed code whose work grows with a data size: rows read, items held in memory, loop iterations, parameters bound or fitted, calls or writes made per item.
2. Trace where that size comes from. Read the callers and the input that reaches the code in production, not the fixtures or the tests. Find every cap, page size, limit or guard on the way, in the code or in the table above.
3. Find where the code runs: on a request a user is waiting for, or off the request path (a queue consumer, a scheduled job, a script).

## The disprove-it pass — required

You may emit a finding only when you can name all three of these, each from the code you read or the table above:

1. **N**: the realistic size this code receives, as a row of the table and its value, and the code path that carries that size to it. A size you cannot connect to the code by reading it is not N.
2. **The growth**: the line where the work grows faster than linearly in N, or is unbounded in N (no cap, no paging, the whole set held at once), and why.
3. **The failure**: what a user sees at that N, with the arithmetic: the request outruns its time budget, the server stops answering other requests while one runs, the process runs out of memory, or a limit in the table rejects the call.

Then try to disprove it. Drop the finding if any of these holds:
- a cap, page size or guard bounds N below the size where it breaks;
- the work is linear and bounded at that N, and fits the time and memory limits in the table;
- the code runs off the request path and its failure there is not user-visible;
- the size row you would need is \`TBD (data team)\`.

A cache does not disprove a finding if the first call after a cold start or expiry still does the work on a request. A test with small inputs does not disprove one either.

If you cannot name all three, emit nothing. An empty answer is the normal result.

## Output

Return a JSON object on the final line of your output. Nothing after it.

{"findings":[
  {
    "path": "src/foo.service.ts",
    "line": 43,
    "body": "<N: the table row and value, and how it reaches this line. Growth: what grows and why. Failure: what the user sees, with the arithmetic.> (Falsification check: <the cap, paging or off-request path that would disprove this, and that it is absent>.)",
    "category": "scale",
    "confidence": "high"
  }
]}

Fields:
- path: repo-relative path exactly as it appears in the diff
- line: new-side line number from the diff hunk, on the line that does the work
- endLine: (optional) last line if the finding spans multiple lines
- body: as above, ending with the falsification-check parenthetical
- category: always "scale"
- confidence: "high" | "medium"

If you have no finding that passed every step, return {"findings":[]}.`,
  tools: ["Read", "Grep", "Glob", ...GIT_TOOL_NAMES],
  model: "claude-sonnet-5-5",
};
