import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

export type ResponsesTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ResponsesItem = Record<string, unknown>;

export type ResponsesUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type ResponsesReply = {
  output: ResponsesItem[];
  usage: ResponsesUsage;
};

const RESPONSES_PATH = "/openai/v1/responses";
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;
// A hung connection would otherwise stall a deep-reviewer until the task's own
// deadline, long past the orchestrator's bounded wait for our result file.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const signers = new Map<string, SignatureV4>();

const signerFor = (region: string): SignatureV4 => {
  const existing = signers.get(region);
  if (existing) return existing;
  const signer = new SignatureV4({
    service: "bedrock",
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  signers.set(region, signer);
  return signer;
};

type RawUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
};

const normalizeUsage = (raw: RawUsage | undefined): ResponsesUsage => ({
  inputTokens: raw?.input_tokens ?? 0,
  cachedInputTokens: raw?.input_tokens_details?.cached_tokens ?? 0,
  outputTokens: raw?.output_tokens ?? 0,
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const callResponses = async (args: {
  region: string;
  model: string;
  instructions: string;
  input: ResponsesItem[];
  tools: ResponsesTool[];
  maxOutputTokens: number;
}): Promise<ResponsesReply> => {
  const hostname = `bedrock-runtime.${args.region}.amazonaws.com`;
  const body = JSON.stringify({
    model: args.model,
    instructions: args.instructions,
    input: args.input,
    tools: args.tools,
    max_output_tokens: args.maxOutputTokens,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: "medium" },
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const signed = await signerFor(args.region).sign(
      new HttpRequest({
        protocol: "https:",
        hostname,
        method: "POST",
        path: RESPONSES_PATH,
        headers: { host: hostname, "content-type": "application/json" },
        body,
      })
    );

    const response = await fetch(`https://${hostname}${RESPONSES_PATH}`, {
      method: "POST",
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      const json = (await response.json()) as {
        output?: unknown;
        usage?: RawUsage;
      };
      return {
        output: Array.isArray(json.output)
          ? (json.output as ResponsesItem[])
          : [],
        usage: normalizeUsage(json.usage),
      };
    }

    const text = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      await sleep(
        BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * BACKOFF_BASE_MS)
      );
      continue;
    }

    const denied =
      response.status === 403 || text.includes("AccessDeniedException");
    throw new Error(
      `Bedrock Responses API returned ${response.status}: ${text.slice(0, 500)}` +
        (denied
          ? ` — ${args.model} may not be subscribed in this account; see scripts/enable-bedrock-models.ts.`
          : "")
    );
  }

  throw new Error(
    `Bedrock Responses API failed after ${MAX_ATTEMPTS} attempts for ${args.model}`
  );
};

const UNCACHED_INPUT_USD_PER_M = 4.4;
const CACHED_INPUT_USD_PER_M = 0.44;
const OUTPUT_USD_PER_M = 22.0;

export const usageCostUsd = (usage: ResponsesUsage): number => {
  const uncachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens
  );
  return (
    (uncachedInput * UNCACHED_INPUT_USD_PER_M +
      usage.cachedInputTokens * CACHED_INPUT_USD_PER_M +
      usage.outputTokens * OUTPUT_USD_PER_M) /
    1_000_000
  );
};
