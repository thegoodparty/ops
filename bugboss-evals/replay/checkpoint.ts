/**
 * A Tier 2 checkpoint: a real incident's Pi session, cut at the moment its
 * pull request opened.
 *
 * The session is read from S3 at runtime and held only in memory and in the
 * replay's scratch directory. It is production data (log lines, query
 * results, people's messages), so it is never written into this repository,
 * and nothing here has a code path that would.
 */

import { readFile } from "node:fs/promises";

type Json = Record<string, unknown>;

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface Checkpoint {
  /** The session, as JSONL, ending with the PR-opening turn and its results. */
  jsonl: string;
  incidentId: string;
  /** The checkout path the session was recorded against (the header's cwd). */
  cwd: string;
  /** When the PR-opening turn ran, epoch millis. */
  prOpenedAt: number;
  pr: PullRequestRef;
  /** The branch the PR was opened from. */
  branch: string;
  title: string | null;
  body: string | null;
  /** Assistant turns in the cut, which the variant's turn budget starts from. */
  turns: number;
  /**
   * The last `get_incident` view the agent received before the cut. The fake
   * Boss serves it back, so the resumed agent sees the incident it left.
   */
  view: Json | null;
  /** The root cause the agent reported before the cut, if it did. */
  rootCause: string | null;
}

const parseS3Uri = (uri: string): { bucket: string; key: string } => {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new Error(`not an s3:// uri: ${uri}`);
  return { bucket: match[1], key: match[2] };
};

/** Reads a session from S3, or from a local path for tests and cached runs. */
export const readSession = async (source: string, region?: string): Promise<string> => {
  if (!source.startsWith("s3://")) return readFile(source, "utf8");
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { bucket, key } = parseS3Uri(source);
  const client = new S3Client(region ? { region } : {});
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`empty object at ${source}`);
  return response.Body.transformToString("utf8");
};

const resultText = (message: Json): string =>
  Array.isArray(message.content)
    ? (message.content as Json[])
        .filter((part) => part.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("\n")
    : "";

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

/**
 * Pulls a flag's value out of a shell command. Quoted values keep their
 * quotes stripped; a heredoc body (`"$(cat <<'EOF' ... EOF)"`) is read whole.
 */
export const flagValue = (command: string, flag: string): string | null => {
  const at = command.search(new RegExp(`(^|\\s)${flag}(\\s|=)`));
  if (at < 0) return null;
  const rest = command.slice(at).replace(new RegExp(`^\\s?${flag}[\\s=]+`), "");
  const heredoc = /^"\$\(cat <<-?'?(\w+)'?\n([\s\S]*?)\n\1\s*\)"/.exec(rest);
  if (heredoc) return heredoc[2];
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(rest);
  if (quoted) return quoted[1] ?? quoted[2];
  const bare = /^(\S+)/.exec(rest);
  return bare ? bare[1] : null;
};

const branchFrom = (commands: string[]): string | null => {
  for (const command of [...commands].reverse()) {
    const head = flagValue(command, "--head");
    if (head && /\bgh\s+pr\s+create\b/.test(command)) return head;
    const push = /\bgit\s+push\b[^\n;&|]*?\borigin\s+(?:HEAD:)?([\w./-]+)/.exec(command);
    if (push) return push[1];
    const create = /\bgit\s+(?:checkout\s+-b|switch\s+-c)\s+([\w./-]+)/.exec(command);
    if (create) return create[1];
  }
  return null;
};

/** The JSON view out of a `get_incident` result: `ok`, a blank line, JSON, then any directives. */
export const viewFromResult = (text: string): Json | null => {
  if (!text.startsWith("ok")) return null;
  const body = text.replace(/^ok\s*/, "");
  const end = body.indexOf("\n\nDIRECTIVES");
  try {
    return JSON.parse(end >= 0 ? body.slice(0, end) : body) as Json;
  } catch {
    return null;
  }
};

/**
 * Cuts a session after the `prOrdinal`th accepted `gh pr create` and the
 * results of every call in that turn. `prOrdinal` is 1-based, because some
 * incidents open a second PR and that is the phase a case may want.
 */
export const cutAtPrOpen = (jsonl: string, prOrdinal = 1): Checkpoint => {
  const lines = jsonl.split("\n").filter((line) => line.trim() !== "");
  const entries = lines.map((line) => JSON.parse(line) as Json);
  const header = entries.find((e) => e.type === "session");
  if (!header) throw new Error("not a Pi session: no session header");

  const commands: string[] = [];
  let seen = 0;
  let turns = 0;
  let view: Json | null = null;
  let rootCause: string | null = null;
  const callNames = new Map<string, { name: string; args: Json }>();

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message as Json;
    if (message.role === "toolResult") {
      const call = callNames.get(String(message.toolCallId));
      const text = resultText(message);
      if (call?.name === "get_incident" && !call.args.incidentId) view = viewFromResult(text) ?? view;
      if (call?.name === "report_root_cause" && text.startsWith("ok")) {
        rootCause = String(call.args.cause ?? "") || rootCause;
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    turns += 1;
    const calls = ((message.content as Json[]) ?? []).filter((p) => p.type === "toolCall");
    for (const call of calls) {
      callNames.set(String(call.id), { name: String(call.name), args: (call.arguments as Json) ?? {} });
      if (call.name === "bash") commands.push(String((call.arguments as Json)?.command ?? ""));
    }
    const prCall = calls.find(
      (call) => call.name === "bash" && /\bgh\s+pr\s+create\b/.test(String((call.arguments as Json)?.command ?? "")),
    );
    if (!prCall) continue;

    // The results of this turn follow it; the cut goes after the last of them.
    const ids = new Set(calls.map((call) => String(call.id)));
    let end = i;
    let prText = "";
    for (let j = i + 1; j < entries.length; j += 1) {
      const next = entries[j].message as Json | undefined;
      if (entries[j].type !== "message" || next?.role !== "toolResult") break;
      if (!ids.has(String(next.toolCallId))) break;
      end = j;
      if (next.toolCallId === prCall.id) prText = resultText(next);
    }
    const url = PR_URL.exec(prText);
    // A refused or failed create opened nothing; keep looking.
    if (!url) continue;
    seen += 1;
    if (seen < prOrdinal) continue;

    const command = String((prCall.arguments as Json).command);
    const branch = branchFrom(commands);
    if (!branch) throw new Error(`cannot tell which branch PR ${url[0]} was opened from`);
    return {
      jsonl: `${lines.slice(0, end + 1).join("\n")}\n`,
      incidentId: String(header.id),
      cwd: String(header.cwd ?? ""),
      prOpenedAt: Number(message.timestamp) || Date.parse(String(entry.timestamp)),
      pr: { owner: url[1], repo: url[2], number: Number(url[3]), url: url[0] },
      branch,
      title: flagValue(command, "--title"),
      body: flagValue(command, "--body"),
      turns,
      view,
      rootCause,
    };
  }
  throw new Error(`the session never opened PR number ${prOrdinal}`);
};

/**
 * Points every github.com URL in a tool result at the stand-in's host, so a
 * resumed `gh pr view <url>` reaches the stand-in rather than the real
 * GitHub. Only tool results are touched: the model's own messages and
 * thinking are left byte for byte as recorded.
 */
export const rewriteGitHubHost = (jsonl: string, host: string): string =>
  jsonl
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const entry = JSON.parse(line) as Json;
      const message = entry.message as Json | undefined;
      if (entry.type !== "message" || message?.role !== "toolResult" || !Array.isArray(message.content)) {
        return line;
      }
      message.content = (message.content as Json[]).map((part) =>
        part.type === "text"
          ? { ...part, text: String(part.text ?? "").replace(/https:\/\/github\.com\//g, `https://${host}/`) }
          : part,
      );
      return JSON.stringify(entry);
    })
    .join("\n");
