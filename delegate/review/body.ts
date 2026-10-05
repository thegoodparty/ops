import type { Finding } from "./schema";
import type { Decision } from "./gates";

export const renderBody = (args: {
  decision: Decision;
  summary: string;
  runId: string;
  headSha: string;
  author: string;
  carriedForward: Array<{ id: string; path: string; line: number; url?: string }>;
  demoted: Finding[];
}): string => {
  const parts: string[] = [];
  const sha7 = args.headSha.slice(0, 7);

  parts.push(`**Recommendation: ${args.decision.verdict}**`);
  parts.push(args.summary);

  if (args.decision.gates.includes("never-approve-author")) {
    parts.push(
      `Approval withheld: ${args.author} is on the never-approve list; a human must approve.`,
    );
  }

  if (args.carriedForward.length > 0) {
    const n = args.carriedForward.length;
    const bullets = args.carriedForward.map((cf) => {
      const label = `${cf.path}:${cf.line}`;
      return cf.url ? `- [${label}](${cf.url})` : `- ${label}`;
    });
    parts.push(`${n} prior finding(s) still open:\n${bullets.join("\n")}`);
  }

  for (const finding of args.demoted) {
    parts.push(`### ${finding.path}:${finding.line}\n${finding.body}`);
  }

  parts.push(`_run ${args.runId} · ${sha7}_`);

  return parts.join("\n\n");
};

export const renderFailureBody = (args: {
  runId: string;
  headSha: string;
  reason: string;
}): string => {
  const sha7 = args.headSha.slice(0, 7);
  const footer = `_run ${args.runId} · ${sha7}_`;
  return `Review failed: ${args.reason}. Re-trigger with \`delegate review\`.\n\n${footer}`;
};
