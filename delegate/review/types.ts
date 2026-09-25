export type SecondOpinionFinding = {
  file: string;
  line: number;
  startLine?: number;
  severity: "blocker" | "concern" | "nit";
  body: string;
  leadArea: string;
  leadCategory: string;
};

export type SecondOpinionResult = {
  status: "ok" | "failed" | "disabled";
  model: string;
  leads: number;
  findings: SecondOpinionFinding[];
  deepReviewersDispatched: number;
  deepReviewerFailures: number;
  scoutFailed: boolean;
  summary: string;
  costUsd: number;
  durationMs: number;
  error?: string;
};
