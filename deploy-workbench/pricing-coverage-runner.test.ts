import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import {
  EXIT_PRICED,
  EXIT_UNPRICED,
  EXIT_UNREADABLE,
  fetchDatasheet,
  main,
  parseArgs,
  render,
} from "./scripts/check-pricing-coverage";
import { checkCoverage, type Datasheet } from "./bifrost/pricing-coverage";

/**
 * The scheduled check's runner: its flags, its three exit codes and the one line
 * per name it prints.
 *
 * The test lives here rather than beside the script because `npm test`'s glob
 * covers `deploy-workbench/*.test.ts` and not `deploy-workbench/scripts/`, so a
 * test next to the script would never run in CI. That is worth stating: the
 * directory it is in is the difference between a test and a comment.
 *
 * The exit codes are the contract with the workflow, which files an issue on 1
 * and only fails the run on 2, so each one is driven end to end through `main`
 * with a temporary config file and a local data source.
 *
 * **Nothing here reaches the network.** The successful cases use a `data:` URL,
 * which `fetch` serves without a socket, and the failing-status cases use one
 * local HTTP server that answers a `404` with a JSON body. Both are deliberate:
 * `npm test` is what every PR runs, and a unit suite that depends on a third
 * party's CDN is a suite that goes red for a reason the change did not cause. It
 * would also pass the exit-2 case for the wrong reason on a runner with no
 * egress, since a DNS failure and a bad status are the same outcome.
 */

const temps: string[] = [];

/** A committed-config-shaped document, written to a temp file. */
const configFile = (models: string[], aliases: Record<string, unknown> = {}): string => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pricing-coverage-")),
    "config.json",
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        bedrock: { keys: [{ name: "k", models, aliases }] },
      },
    }),
  );
  temps.push(path.dirname(file));
  return file;
};

/** A datasheet served from a data: URL, so no socket is opened. */
const datasheetUrl = (datasheet: Datasheet): string =>
  `data:application/json,${encodeURIComponent(JSON.stringify(datasheet))}`;

/** One priced row, with deliberately tiny non-real numbers. */
const pricedRow = { provider: "bedrock", mode: "chat", input_cost_per_token: 1 };

/** A local server that answers everything with a `404` and a JSON body. */
let notFoundBase = "";
let notFoundServer: http.Server | undefined;

before(async () => {
  notFoundServer = http.createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) =>
    notFoundServer?.listen(0, "127.0.0.1", resolve),
  );
  const address = notFoundServer?.address() as AddressInfo;
  notFoundBase = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) =>
    notFoundServer === undefined ? resolve() : notFoundServer.close(() => resolve()),
  );
});

/** `main` with the console silenced, so the run's rc is the only thing read. */
const runQuietly = async (argv: string[]): Promise<number> => {
  const { log, error } = console;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await main(argv);
  } finally {
    console.log = log;
    console.error = error;
  }
};

describe("the runner's arguments", () => {
  it("defaults to the committed config and the gateway's own datasheet", () => {
    const args = parseArgs([]);
    assert.ok(args.configPath.endsWith(path.join("bifrost", "config.json")));
    assert.equal(args.datasheetUrl, "https://getbifrost.ai/datasheet");
  });

  it("takes an override for each, which is how the failure path is exercised", () => {
    const args = parseArgs(["--config", "x.json", "--datasheet-url", "http://example/x"]);
    assert.ok(args.configPath.endsWith("x.json"));
    assert.equal(args.datasheetUrl, "http://example/x");
  });

  it("refuses an unknown or incomplete flag instead of ignoring it", () => {
    // An ignored typo is a run that checks the default file and reports green
    // for a config nobody asked about.
    assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
    assert.throws(() => parseArgs(["--config"]), /needs a path/);
  });
});

describe("reading the datasheet", () => {
  it("returns the parsed object", async () => {
    const parsed = await fetchDatasheet(datasheetUrl({ "bedrock/m": pricedRow }));
    assert.deepEqual(parsed, { "bedrock/m": pricedRow });
  });

  it("throws on a non-2xx rather than returning an empty feed", async () => {
    // The distinction that matters: an empty feed would report every served name
    // as unpriced, which is the loudest possible wrong answer, so a bad status
    // has to be a failure and not a result. A local 404, so this asserts the
    // status branch rather than a DNS resolver's behaviour.
    await assert.rejects(
      () => fetchDatasheet(`${notFoundBase}/datasheet`),
      /answered 404/,
    );
  });

  it("throws on a 200 that is not a JSON object", async () => {
    const body = "<html>an HTML catch-all page</html>";
    await assert.rejects(
      () => fetchDatasheet(`data:text/html,${encodeURIComponent(body)}`),
      /not JSON/,
    );
  });
});

describe("the report", () => {
  it("states the verdict for every name, priced or not", () => {
    const results = checkCoverage(
      { providers: { bedrock: { keys: [{ models: ["a", "b"] }] } } },
      { "bedrock/a": pricedRow },
    );
    const lines = render(results);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /priced\s+bedrock\/a/);
    assert.match(lines[0], /own-id/);
    assert.match(lines[1], /UNPRICED\s+bedrock\/b/);
    assert.match(lines[1], /no-row/);
  });

  it("never prints a rate", () => {
    // The repository is public. A verdict and a candidate name are facts about
    // the config; a rate is a price.
    const results = checkCoverage(
      { providers: { bedrock: { keys: [{ models: ["a"] }] } } },
      { "bedrock/a": pricedRow },
    );
    const text = render(results).join("\n");
    assert.ok(!/0\.000|per_token|input_cost/.test(text), `the report leaked a rate: ${text}`);
  });
});

describe("the exit codes, end to end", () => {
  it("exits 0 when every served name resolves", async () => {
    const code = await runQuietly([
      "--config",
      configFile(["a"]),
      "--datasheet-url",
      datasheetUrl({ "bedrock/a": pricedRow }),
    ]);
    assert.equal(code, EXIT_PRICED);
  });

  it("exits 1 when a served name has no row", async () => {
    const code = await runQuietly([
      "--config",
      configFile(["a", "brand-new"]),
      "--datasheet-url",
      datasheetUrl({ "bedrock/a": pricedRow }),
    ]);
    assert.equal(code, EXIT_UNPRICED);
  });

  it("exits 1 when a served name's only row computes nothing", async () => {
    const code = await runQuietly([
      "--config",
      configFile(["zero"]),
      "--datasheet-url",
      datasheetUrl({ "bedrock/zero": { provider: "bedrock", mode: "chat" } }),
    ]);
    assert.equal(code, EXIT_UNPRICED);
  });

  it("exits 2, not 1, when the datasheet cannot be read", async () => {
    // The one distinction the workflow depends on: 2 files no issue and 1 files
    // one, so a CDN outage cannot masquerade as an unpriced model.
    const code = await runQuietly([
      "--config",
      configFile(["a"]),
      "--datasheet-url",
      `${notFoundBase}/datasheet`,
    ]);
    assert.equal(code, EXIT_UNREADABLE);
  });

  it("exits 2 when the config file is missing", async () => {
    const code = await runQuietly([
      "--config",
      path.join(os.tmpdir(), "pricing-coverage-does-not-exist.json"),
      "--datasheet-url",
      datasheetUrl({}),
    ]);
    assert.equal(code, EXIT_UNREADABLE);
  });
});
