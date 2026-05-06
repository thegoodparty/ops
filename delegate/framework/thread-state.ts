export type Phase = "tech-design" | "epic" | "epic-edit" | "task-execution";
export type Status = "draft" | "blessed" | "abandoned";

const PHASES: readonly Phase[] = [
  "tech-design",
  "epic",
  "epic-edit",
  "task-execution",
] as const;

const STATUSES: readonly Status[] = [
  "draft",
  "blessed",
  "abandoned",
] as const;

export const isPhase = (v: unknown): v is Phase =>
  typeof v === "string" && (PHASES as readonly string[]).includes(v);

export const isStatus = (v: unknown): v is Status =>
  typeof v === "string" && (STATUSES as readonly string[]).includes(v);

export type ThreadState = {
  phase: Phase;
  status: Status;
  clickup: string;
  // The runbooks SHA used for the prior post. Optional — the canonical
  // record is the message footer (`runbooks=<sha>`), which the worker
  // appends at runtime. We accept it here for legacy posts but no longer
  // require LLMs to emit it in the header.
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
  if (!isPhase(fields.phase) || !isStatus(fields.status)) return null;
  return {
    phase: fields.phase,
    status: fields.status,
    clickup: fields.clickup,
    ...(fields.runbooks ? { runbooks: fields.runbooks } : {}),
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
