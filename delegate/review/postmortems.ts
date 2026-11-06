import { execFileSync } from "child_process";

export const POSTMORTEM_DIR = "docs/postmortems";
// Every post-mortem goes into the review prompt, so the total is capped.
// Newest first by file name (they are dated), so the cap drops the oldest.
export const POSTMORTEM_MAX_CHARS = 120_000;

const EXEC_OPTS = { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 } as const;

// Post-mortems are read from the PR's base commit, never its head: a PR
// cannot add, edit or delete the incidents it is reviewed against, and a
// post-mortem steers a review only after it has itself merged through one.
export const readPostmortems = (repoDir: string, ref: string): { path: string; text: string }[] => {
  let paths: string[];
  try {
    paths = execFileSync("git", ["ls-tree", "--name-only", `${ref}:${POSTMORTEM_DIR}`], { cwd: repoDir, ...EXEC_OPTS })
      .toString()
      .split("\n")
      .filter((p) => p.endsWith(".md") && p.toLowerCase() !== "readme.md")
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out: { path: string; text: string }[] = [];
  let total = 0;
  for (const name of paths) {
    const path = `${POSTMORTEM_DIR}/${name}`;
    const text = execFileSync("git", ["show", `${ref}:${path}`], { cwd: repoDir, ...EXEC_OPTS }).toString();
    if (total + text.length > POSTMORTEM_MAX_CHARS) break;
    total += text.length;
    out.push({ path, text });
  }
  return out;
};
