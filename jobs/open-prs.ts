import { defineJob } from "./framework";

export default defineJob(
  { schedule: "cron(0 14 ? * MON-FRI *)" },
  async (ctx) => {
    const { data: repos } = await ctx.github.repos.listForOrg({
      org: "thegoodparty",
      per_page: 100,
      type: "sources",
    });

    const allPrs = await Promise.all(
      repos.map(async (repo) => {
        const { data: prs } = await ctx.github.pulls.list({
          owner: "thegoodparty",
          repo: repo.name,
          state: "open",
          per_page: 100,
        });
        return prs.map((pr) => ({ ...pr, repoName: repo.name }));
      })
    );

    const prs = allPrs.flat();

    if (prs.length === 0) {
      await ctx.slack.chat.postMessage({
        channel: "#serve-dev",
        text: "No open PRs right now! :tada:",
      });
      return;
    }

    const lines = prs.map(
      (pr) =>
        `• <${pr.html_url}|${pr.title}> (${pr.repoName}) — ${
          pr.user?.login ?? "unknown"
        }`
    );

    await ctx.slack.chat.postMessage({
      channel: "#serve-dev",
      text: `*Open PRs (${prs.length}):*\n${lines.join("\n")}`,
    });
  }
);
