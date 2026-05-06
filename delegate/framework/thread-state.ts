export type Phase = "tech-design" | "epic" | "epic-edit" | "task-execution";
export type Status = "draft" | "blessed" | "abandoned";

export type ThreadState = {
  phase: Phase;
  status: Status;
  clickup: string;
  runbooks?: string;
};

const HEADER_RE = /^\[(.+?)\]/;

export const parseHeader = (text: string): ThreadState | null => {
  const m = text.trim().match(HEADER_RE);
  if (!m) return null;
  const fields: Record<string, string> = Object.fromEntries(
    m[1].split(",").map((kv) => {
      const [k, ...v] = kv.split("=");
      return [k.trim(), v.join("=").trim()];
    }),
  );
  if (!fields.phase || !fields.status || !fields.clickup) return null;
  return {
    phase: fields.phase as Phase,
    status: fields.status as Status,
    clickup: fields.clickup,
    runbooks: fields.runbooks,
  };
};

export const emitHeader = (state: ThreadState): string => {
  const parts = [
    `phase=${state.phase}`,
    `status=${state.status}`,
    `clickup=${state.clickup}`,
  ];
  if (state.runbooks) parts.push(`runbooks=${state.runbooks}`);
  return `[${parts.join(",")}]`;
};

// Walks newest-first; returns the parsed state from the most recent bot
// message whose first non-empty line matches the header pattern. Workflows
// iterate (edit → edit → bless), so the last header is the resume point.
export const findLatestState = (
  messages: Array<{ text?: string; bot_id?: string }>,
): ThreadState | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.bot_id || !m.text) continue;
    const firstLine = m.text.split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) continue;
    const parsed = parseHeader(firstLine);
    if (parsed) return parsed;
  }
  return null;
};
