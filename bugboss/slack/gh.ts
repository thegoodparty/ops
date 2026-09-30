// The Boss's `gh`: the same GitHub CLI, on the same App installation token,
// that an incident agent drives from bash. The Boss has no shell, so the
// model hands over an argv and this runs it with execFile -- no shell, so a
// pipe, a redirect or a `;` in an argument is only ever a literal argument.

import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeAlarm } from "../logging";
import type { SlackAgentTool } from "./agent";

const alarm = makeAlarm("slack-gh");

export interface GhOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Printed more than the pipe buffer holds, so what came back is partial and is never shown. */
  overflowed: boolean;
}

export type GhExec = (args: string[]) => Promise<GhOutcome>;

/** One gh call's wall-clock bound. Counted into the thread lock's lease. */
export const GH_TIMEOUT_MS = 30_000;

/**
 * The most one gh call hands back. Past it the answer is a refusal that says
 * how to ask for less, never the first part of the output: a PR list cut
 * after its tenth row reads as a list of ten.
 */
export const MAX_GH_OUTPUT_CHARS = 40_000;

/** What `gh` resolves a command to when no `--repo` is given. */
export const DEFAULT_GH_REPO = "thegoodparty/omni";

/**
 * `gh auth token` prints the token into the transcript, and a transcript is
 * one answer away from a Slack thread. `alias --shell` and `extension` run
 * arbitrary programs as this process's user, which can read this process's
 * environment -- every secret the Boss holds, not only GitHub's. `config`
 * would let one call change what the next one means.
 */
const REFUSED_COMMANDS = new Set(["auth", "alias", "extension", "ext", "config"]);

const PIPE_BUFFER_BYTES = 16 * 1024 * 1024;

export const createGhExec = ({
  token,
  binary = "gh",
  timeoutMs = GH_TIMEOUT_MS,
}: {
  token: () => Promise<string>;
  binary?: string;
  timeoutMs?: number;
}): GhExec => {
  // Its own config directory, so nothing gh remembers between calls -- a
  // host, a default repo -- comes from anywhere but this process.
  const configDir = mkdtempSync(join(tmpdir(), "bugboss-gh-"));
  return async (args) => {
    const current = await token();
    return new Promise((resolve) => {
      execFile(
        binary,
        args,
        {
          // Built, not inherited: the child sees GitHub's credential and
          // none of the Boss's others.
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME ?? tmpdir(),
            GH_TOKEN: current,
            GITHUB_TOKEN: current,
            GH_CONFIG_DIR: configDir,
            GH_REPO: DEFAULT_GH_REPO,
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
            GH_PAGER: "",
            NO_COLOR: "1",
          },
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: PIPE_BUFFER_BYTES,
        },
        (err, stdout, stderr) => {
          // gh does not echo its token, but an error from GitHub or a URL a
          // command prints could, and this text goes to a model that writes
          // into Slack.
          const scrub = (text: string) => (current ? text.split(current).join("[token]") : text);
          const failure = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          resolve({
            exitCode: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
            stdout: scrub(String(stdout)),
            stderr: scrub(String(stderr || (failure && typeof failure.code === "string" ? failure.message : ""))),
            timedOut: Boolean(failure?.killed) && failure?.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            overflowed: failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          });
        },
      );
    });
  };
};

const narrower =
  "Ask for less: --json with only the fields you need and --jq to pick from them, --limit on a list, `gh pr diff --name-only` rather than the whole diff, `gh api` with --jq.";

export const buildGhTool = (gh: GhExec | null): SlackAgentTool => ({
  name: "gh",
  description: [
    "Run the GitHub CLI, `gh`, as BugBoss's GitHub App -- the same access an incident agent has. Pass the arguments as an array, without the leading `gh`; there is no shell, so no pipes, redirects or quoting.",
    `The default repository is ${DEFAULT_GH_REPO}; pass --repo owner/name for any other.`,
    "Examples: [\"pr\",\"view\",\"2265\",\"--json\",\"title,author,state,createdAt,mergedAt,headRefName,body,files,reviews\"], [\"pr\",\"list\",\"--search\",\"alert grouping\",\"--state\",\"all\",\"--limit\",\"10\",\"--json\",\"number,title,author,state\"], [\"run\",\"list\",\"--branch\",\"feat/x\",\"--limit\",\"5\"] for CI -- the App cannot read check runs, so `pr checks` and statusCheckRollup fail or come back empty; workflow runs are how CI is read.",
    `At most ${MAX_GH_OUTPUT_CHARS} characters come back; a call that prints more is refused whole, not cut, so ask for specific --json fields rather than everything.`,
    "auth, alias, extension and config are refused.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description: "The gh arguments, e.g. [\"pr\",\"view\",\"2265\",\"--json\",\"title,author\"].",
      },
    },
    required: ["args"],
    additionalProperties: false,
  },
  run: async (input) => {
    if (!gh) {
      return "Unavailable: this deployment has no GitHub App credentials, so gh cannot run. Say so rather than guessing.";
    }
    const args = Array.isArray(input.args) ? input.args : null;
    if (!args || args.length === 0 || args.some((a) => typeof a !== "string")) {
      return "Refused: args must be a non-empty array of strings, without the leading `gh`. Nothing ran.";
    }
    const argv = args as string[];
    const command = argv[0];
    if (command === "gh") {
      return "Refused: leave out the leading `gh`; args starts at the command, e.g. [\"pr\",\"view\",\"2265\"]. Nothing ran.";
    }
    if (REFUSED_COMMANDS.has(command)) {
      return `Refused: \`gh ${command}\` is not available here -- it would expose credentials or run a program outside gh. Nothing ran.`;
    }

    let outcome: GhOutcome;
    try {
      outcome = await gh(argv);
    } catch (err) {
      alarm("gh_unavailable", { command, error: String(err) });
      return `Failed: gh could not run (${String(err)}). Nothing was read; say so.`;
    }
    const { stdout, stderr } = outcome;

    if (outcome.timedOut) {
      return `Timed out: gh ${command} ran past ${GH_TIMEOUT_MS / 1000} seconds and was stopped. Nothing is shown. ${narrower}`;
    }
    const size = stdout.length + stderr.length;
    if (outcome.overflowed || size > MAX_GH_OUTPUT_CHARS) {
      return `Refused: gh ${command} printed ${outcome.overflowed ? "more than the pipe holds" : `${size} characters`}, over the ${MAX_GH_OUTPUT_CHARS} this tool hands back. Nothing is shown rather than a part of it. ${narrower}`;
    }
    if (outcome.exitCode !== 0) {
      return `gh exited ${outcome.exitCode ?? "abnormally"}.\n${stderr.trim() || stdout.trim() || "(no output)"}`;
    }
    const body = stdout.trim() || "(no output)";
    return stderr.trim() ? `${body}\n[stderr]\n${stderr.trim()}` : body;
  },
});
