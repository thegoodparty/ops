/**
 * Does every model the gateway serves have a price? Run from CI, on a schedule.
 *
 * The gateway prices a request from one remote datasheet and logs a miss as a
 * cost of zero, silently, and a model priced at zero is also invisible to a
 * per-provider budget. So the only way anyone learns that a newly served model
 * is not being billed is to look, and nobody looks. This does the looking.
 *
 * ## Why this is a script and not a workflow step in an existing job
 *
 * It needs nothing from AWS: it reads the committed `config.json` and one public
 * JSON document over `fetch`. Putting it in `deploy-workbench.yml` would run it
 * on a runner holding a deploy role for no reason, and `deploy.yml`'s test job
 * would make a unit suite depend on a third party's CDN. A workflow of its own
 * with `contents: read` and `issues: write` is the smallest thing that can fail
 * where a person sees it.
 *
 * ## The three exit codes, and why they are three
 *
 * - `0`: every served name resolves to a row that computes a non-zero cost.
 * - `1`: at least one served name does not. This is the fact the issue is about.
 * - `2`: the datasheet could not be read, so the question was not answered.
 *
 * A 2 must never be reported as a 1. "A model is unpriced" and "we could not
 * check" have different owners and different fixes, and a check that cannot tell
 * them apart teaches everyone to close the issue without reading it. The
 * workflow files or updates an issue on 1 only, and fails the run on both.
 *
 * ## One line per name, and no rate ever
 *
 * The report prints each served name with its verdict, so a green run states
 * what it checked rather than printing nothing. It prints which candidate
 * resolved, never a rate or a cost: this repository is public.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { BIFROST_PRICING_TAG, checkCoverage, unpriced, type Datasheet } from "../bifrost/pricing-coverage";

/** The datasheet the gateway itself reads; `store.go`'s `DefaultURL`. */
const DEFAULT_DATASHEET_URL = "https://getbifrost.ai/datasheet";

/** The committed config, the serve list's source of truth. */
const DEFAULT_CONFIG_PATH = path.resolve(
  __dirname,
  "../bifrost/config.json",
);

/** Bounded so a hung CDN is a failure in a minute rather than in a runner's limit. */
const FETCH_TIMEOUT_MS = 60_000;

export const EXIT_PRICED = 0;
export const EXIT_UNPRICED = 1;
export const EXIT_UNREADABLE = 2;

/** The flags this script accepts, so the workflow's line is the whole contract. */
export type Args = {
  configPath: string;
  datasheetUrl: string;
};

export const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    configPath: DEFAULT_CONFIG_PATH,
    datasheetUrl: DEFAULT_DATASHEET_URL,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--config") {
      const value = argv[i + 1];
      if (!value) throw new Error("--config needs a path");
      args.configPath = path.resolve(value);
      i += 1;
    } else if (flag === "--datasheet-url") {
      const value = argv[i + 1];
      if (!value) throw new Error("--datasheet-url needs a URL");
      args.datasheetUrl = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      throw new Error(
        "usage: check-pricing-coverage [--config <path>] [--datasheet-url <url>]",
      );
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  return args;
};

/**
 * The datasheet, or a throw a caller can turn into exit 2.
 *
 * `redirect: "follow"` is the default and is kept: the URL is a stable name that
 * has redirected before. The status is checked rather than trusted, because a
 * `404` page parses as nothing and would otherwise look like an empty feed,
 * which would report every served name as unpriced — the loudest possible wrong
 * answer.
 */
export const fetchDatasheet = async (url: string): Promise<Datasheet> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`the datasheet answered ${response.status}`);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the datasheet is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the datasheet is not a JSON object");
  }
  return parsed as Datasheet;
};

/** One line per served name. The indentation is the workflow's annotation shape. */
export const render = (
  results: ReturnType<typeof checkCoverage>,
): string[] => {
  const lines: string[] = [];
  for (const result of results) {
    const { provider, name } = result.served;
    if (result.priced) {
      lines.push(
        `  priced    ${provider}/${name}  (${result.pricedBy}, ${result.mode}; ${BIFROST_PRICING_TAG} lookup)`,
      );
    } else {
      lines.push(
        `  UNPRICED  ${provider}/${name}  (${result.reason}; tried ${result.tried.join(", ")})`,
      );
    }
  }
  return lines;
};

/**
 * The issue's title. Fixed, so a second night of the same outage updates one
 * issue instead of filing another, and so the workflow can find the open one by
 * title alone.
 */
export const ISSUE_TITLE = "Bifrost: a served model has no price";

export const main = async (argv: string[]): Promise<number> => {
  const args = parseArgs(argv);

  let configText: string;
  try {
    configText = fs.readFileSync(args.configPath, "utf8");
  } catch {
    console.error(`could not read ${args.configPath}`);
    return EXIT_UNREADABLE;
  }

  let datasheet: Datasheet;
  try {
    datasheet = await fetchDatasheet(args.datasheetUrl);
  } catch (error) {
    // Not an unpriced model. The run fails and the workflow files nothing,
    // because an issue that says "we could not check" is the one people learn
    // to close without reading.
    console.error(
      `could not read the datasheet at ${args.datasheetUrl}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return EXIT_UNREADABLE;
  }

  const results = checkCoverage(JSON.parse(configText) as unknown, datasheet);
  for (const line of render(results)) console.log(line);

  const missing = unpriced(results);
  if (missing.length === 0) {
    console.log(
      `\nall ${results.length} served models resolve against the ${BIFROST_PRICING_TAG} lookup`,
    );
    return EXIT_PRICED;
  }

  console.log(
    `\n${missing.length} of ${results.length} served models would be logged at a cost of zero`,
  );
  return EXIT_UNPRICED;
};

// `run-script.ts` imports a default function; the workflow calls this file
// directly through tsx, so the entry point is guarded rather than assumed.
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = EXIT_UNREADABLE;
    });
}
