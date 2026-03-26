import { z } from "zod";
import { defineAgentJob } from "./framework";

export default defineAgentJob(
  {
    schedule: "cron(0 10 ? * MON *)",
    agent: {
      prompt: `Review documentation in each repository in the thegoodparty GitHub org for drift from reality.

For each repo:
1. Clone it with \`gh repo clone thegoodparty/<repo> -- --depth 1\`
2. Read any documentation files (README.md, CLAUDE.md, docs/, etc.)
3. Compare the documentation against the actual code — look for:
   - Referenced files, functions, or commands that no longer exist
   - Documented patterns or architecture that no longer match the code
   - Outdated environment variables, config, or deployment instructions
   - Missing documentation for significant new features or patterns
4. If you find meaningful drift, create a branch, fix the docs, and open a PR with \`gh pr create\`

Skip repos that have no documentation or where the docs are accurate.

Focus on the main repos: gp-webapp, gp-api, people-api, election-api, gp-ai-projects, serve-ops.

Return the list of PRs you created. If no drift was found, return an empty array.`,
      model: "claude-sonnet-4-20250514",
    },
    outputSchema: z.object({
      prs: z.array(
        z.object({
          repo: z.string(),
          url: z.string(),
          summary: z.string(),
        })
      ),
    }),
  },
  async (ctx, output) => {
    if (output.prs.length === 0) {
      await ctx.slack.chat.postMessage({
        channel: "#serve-dev",
        text: "Docs drift check complete — all documentation looks current.",
      });
      return;
    }

    const lines = output.prs.map(
      (pr) => `  \u2022 <${pr.url}|\`${pr.repo}\`>: ${pr.summary}`,
    );

    await ctx.slack.chat.postMessage({
      channel: "#serve-dev",
      text: `*Docs drift detected — ${output.prs.length} PR(s) created:*\n${lines.join("\n")}`,
    });
  },
);
