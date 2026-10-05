import type { Finding } from "./schema";

export const parseDiffAnchors = (diff: string): Map<string, Set<number>> => {
  const anchors = new Map<string, Set<number>>();
  const lines = diff.split("\n");

  let currentPath: string | null = null;
  let inHunk = false;
  let newLineNum = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      newLineNum = 0;
      continue;
    }

    if (line.startsWith("@@ ")) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        newLineNum = parseInt(match[1], 10);
        inHunk = true;
        if (currentPath !== null && !anchors.has(currentPath)) {
          anchors.set(currentPath, new Set());
        }
      }
      continue;
    }

    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        const pathPart = line.slice(4).split("\t")[0];
        if (pathPart === "/dev/null") {
          currentPath = null;
        } else if (pathPart.startsWith("b/")) {
          currentPath = pathPart.slice(2);
        } else {
          currentPath = pathPart;
        }
      }
      continue;
    }

    if (line.startsWith(" ") || line.startsWith("+")) {
      if (currentPath !== null) {
        let set = anchors.get(currentPath);
        if (!set) {
          set = new Set();
          anchors.set(currentPath, set);
        }
        set.add(newLineNum);
      }
      newLineNum++;
    } else if (line.startsWith("-")) {
      // old-side only; new-side line counter does not advance
    }
    // "\" (no newline at end of file) — skip without advancing
  }

  return anchors;
};

export const isAnchorable = (
  anchors: Map<string, Set<number>>,
  path: string,
  line: number,
  endLine?: number,
): boolean => {
  const set = anchors.get(path);
  if (!set) return false;
  const end = endLine ?? line;
  for (let l = line; l <= end; l++) {
    if (!set.has(l)) return false;
  }
  return true;
};

export const placeFindings = (
  findings: Finding[],
  anchors: Map<string, Set<number>>,
): Array<{ finding: Finding; demoted: boolean }> =>
  findings.map((finding) => {
    const anchorable = isAnchorable(
      anchors,
      finding.path,
      finding.line,
      finding.endLine,
    );
    if (!anchorable && finding.suggestion !== undefined) {
      const { suggestion, ...rest } = finding;
      const bodyWithSuggestion = `${rest.body}\n\n\`\`\`\n${suggestion}\n\`\`\``;
      return { finding: { ...rest, body: bodyWithSuggestion }, demoted: true };
    }
    return { finding, demoted: !anchorable };
  });
