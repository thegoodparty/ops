// The diff the agent is shown is not always the diff that was reviewed.
// Deleted files carry no reviewable lines, so their hunks become a name in a
// list; and a diff that would not fit in the first message goes to a file
// inside the checkout for the agent to read in parts. The record and the
// anchor parser always see the full diff.
export const INLINE_DIFF_LIMIT = 120_000;

export type PromptDiff = {
  inline: string;
  deletedFiles: string[];
  stat: string;
  oversized: boolean;
};

type FileSection = { header: string; path: string; deleted: boolean; added: number; removed: number };

const splitSections = (diff: string): Array<{ text: string; info: FileSection }> => {
  const sections: Array<{ text: string; info: FileSection }> = [];
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.length > 0);
  for (const text of parts) {
    const lines = text.split("\n");
    const header = lines[0];
    const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const path = m ? m[2] : header.replace(/^diff --git /, "");
    const deleted = lines.some((l) => l.startsWith("+++ /dev/null"));
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const l of lines) {
      if (l.startsWith("@@")) inHunk = true;
      else if (inHunk && l.startsWith("+")) added++;
      else if (inHunk && l.startsWith("-")) removed++;
    }
    sections.push({ text, info: { header, path, deleted, added, removed } });
  }
  return sections;
};

export const promptDiff = (diff: string, limit = INLINE_DIFF_LIMIT): PromptDiff => {
  const sections = splitSections(diff);
  const deletedFiles = sections.filter((s) => s.info.deleted).map((s) => s.info.path);
  const kept = sections.filter((s) => !s.info.deleted);
  const inline = kept.map((s) => s.text).join("");
  const stat = sections
    .map((s) =>
      s.info.deleted
        ? `${s.info.path} | deleted (-${s.info.removed})`
        : `${s.info.path} | +${s.info.added} -${s.info.removed}`,
    )
    .join("\n");
  return { inline, deletedFiles, stat, oversized: inline.length > limit };
};
