import type {
  AssembledBlock,
  AssembledMessage,
  ProxyCost,
  ProxyUsage,
} from "../../core/adapters/proxy-log";
import type { Rates } from "../../core/price";
import type { Frame } from "./eventstream";

type Json = Record<string, unknown>;

export const emptyUsage = (): ProxyUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  split: false,
});

export const zeroCost = (): ProxyCost => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

/**
 * An absent `cache_creation` split is priced as all 1h, the dearer rate,
 * because this number holds a cap and must not under-count.
 */
export const priceUsage = (rates: Rates, usage: ProxyUsage): ProxyCost => {
  const input = usage.input * rates.input;
  const output = usage.output * rates.output;
  const cacheRead = usage.cacheRead * rates.cacheRead;
  const cacheWrite = usage.split
    ? usage.cacheWrite1h * rates.cacheWrite1h + usage.cacheWrite5m * rates.cacheWrite5m
    : usage.cacheWrite * rates.cacheWrite1h;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
};

const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

const applyUsage = (usage: ProxyUsage, raw: Json | undefined): void => {
  if (!raw) return;
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const cacheRead = num(raw.cache_read_input_tokens);
  const cacheWrite = num(raw.cache_creation_input_tokens);
  if (input !== null) usage.input = input;
  if (output !== null) usage.output = output;
  if (cacheRead !== null) usage.cacheRead = cacheRead;
  if (cacheWrite !== null) usage.cacheWrite = cacheWrite;
  const split = raw.cache_creation as Json | undefined;
  if (split && typeof split === "object") {
    usage.cacheWrite1h = num(split.ephemeral_1h_input_tokens) ?? 0;
    usage.cacheWrite5m = num(split.ephemeral_5m_input_tokens) ?? 0;
    usage.split = true;
  }
};

/** Bedrock's own counts, the backstop when no Anthropic usage arrived. */
const applyInvocationMetrics = (usage: ProxyUsage, metrics: Record<string, number>): void => {
  usage.input ||= metrics.inputTokenCount ?? 0;
  usage.output ||= metrics.outputTokenCount ?? 0;
  usage.cacheRead ||= metrics.cacheReadInputTokenCount ?? 0;
  usage.cacheWrite ||= metrics.cacheWriteInputTokenCount ?? 0;
};

interface PartialBlock {
  block: AssembledBlock;
  json: string;
}

export interface AssembledResponse {
  message: AssembledMessage | null;
  usage: ProxyUsage;
  invocationMetrics: Record<string, number> | null;
  exception: { type: string; message: string } | null;
}

/**
 * Builds the response record from Anthropic Messages stream events as they
 * arrive. Bedrock wraps the same events in event-stream frames (`addFrame`);
 * the Anthropic API sends them as server-sent events (`addSse`).
 */
export class StreamAssembler {
  private message: AssembledMessage | null = null;
  private blocks = new Map<number, PartialBlock>();
  readonly usage = emptyUsage();
  private metrics: Record<string, number> | null = null;
  private ssePending = "";
  exception: { type: string; message: string } | null = null;

  addFrame(frame: Frame): void {
    const messageType = frame.headers[":message-type"];
    if (messageType === "exception" || messageType === "error") {
      const type = String(frame.headers[":exception-type"] ?? frame.headers[":error-code"] ?? "error");
      let message = String(frame.headers[":error-message"] ?? "");
      try {
        const body = JSON.parse(frame.payload.toString("utf8")) as Json;
        message = String(body.message ?? body.Message ?? message);
      } catch {
        message ||= frame.payload.toString("utf8");
      }
      this.exception = { type, message };
      return;
    }
    if (frame.headers[":event-type"] !== "chunk") return;
    const wrapper = JSON.parse(frame.payload.toString("utf8")) as { bytes?: string };
    if (typeof wrapper.bytes !== "string") return;
    this.addEvent(JSON.parse(Buffer.from(wrapper.bytes, "base64").toString("utf8")) as Json);
  }

  addSse(text: string): void {
    this.ssePending += text;
    let boundary = this.ssePending.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = this.ssePending.slice(0, boundary);
      this.ssePending = this.ssePending.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data !== "") {
        try {
          this.addEvent(JSON.parse(data) as Json);
        } catch {
          // A partial or non-JSON data line costs the record a field, never the relay.
        }
      }
      boundary = this.ssePending.indexOf("\n\n");
    }
  }

  addEvent(event: Json): void {
    const metrics = event["amazon-bedrock-invocationMetrics"];
    if (metrics && typeof metrics === "object") {
      this.metrics = metrics as Record<string, number>;
    }
    switch (event.type) {
      case "error": {
        const error = (event.error ?? {}) as Json;
        this.exception = { type: String(error.type ?? "error"), message: String(error.message ?? "") };
        return;
      }
      case "message_start": {
        const message = (event.message ?? {}) as Json;
        this.message = {
          id: String(message.id ?? ""),
          model: String(message.model ?? ""),
          content: [],
          stopReason: null,
        };
        applyUsage(this.usage, message.usage as Json | undefined);
        return;
      }
      case "content_block_start": {
        const block = { ...((event.content_block ?? {}) as Json) } as AssembledBlock;
        if (block.type === "tool_use") (block as Json).input = {};
        this.blocks.set(Number(event.index), { block, json: "" });
        return;
      }
      case "content_block_delta": {
        const partial = this.blocks.get(Number(event.index));
        if (!partial) return;
        const delta = (event.delta ?? {}) as Json;
        const block = partial.block as Json;
        if (delta.type === "text_delta") block.text = String(block.text ?? "") + String(delta.text ?? "");
        if (delta.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + String(delta.thinking ?? "");
        if (delta.type === "signature_delta") block.signature = String(block.signature ?? "") + String(delta.signature ?? "");
        if (delta.type === "input_json_delta") partial.json += String(delta.partial_json ?? "");
        return;
      }
      case "content_block_stop": {
        const partial = this.blocks.get(Number(event.index));
        if (!partial) return;
        this.finish(partial);
        this.blocks.delete(Number(event.index));
        return;
      }
      case "message_delta": {
        const delta = (event.delta ?? {}) as Json;
        if (this.message && typeof delta.stop_reason === "string") {
          this.message.stopReason = delta.stop_reason;
        }
        applyUsage(this.usage, event.usage as Json | undefined);
        return;
      }
    }
  }

  private finish(partial: PartialBlock): void {
    const block = partial.block as Json;
    if (block.type === "tool_use" && partial.json !== "") {
      try {
        block.input = JSON.parse(partial.json);
      } catch {
        block.input = partial.json;
        block.inputUnparsed = true;
      }
    }
    this.message?.content.push(partial.block);
  }

  result(): AssembledResponse {
    for (const partial of this.blocks.values()) this.finish(partial);
    this.blocks.clear();
    if (this.metrics) applyInvocationMetrics(this.usage, this.metrics);
    return {
      message: this.message,
      usage: this.usage,
      invocationMetrics: this.metrics,
      exception: this.exception,
    };
  }
}

/** A non-streaming body is one Anthropic message, on either upstream. */
export const assembleBody = (text: string): AssembledResponse => {
  const usage = emptyUsage();
  const body = JSON.parse(text) as Json;
  applyUsage(usage, body.usage as Json | undefined);
  const metrics = body["amazon-bedrock-invocationMetrics"];
  if (metrics && typeof metrics === "object") {
    applyInvocationMetrics(usage, metrics as Record<string, number>);
  }
  return {
    message: {
      id: String(body.id ?? ""),
      model: String(body.model ?? ""),
      content: (body.content as AssembledBlock[] | undefined) ?? [],
      stopReason: typeof body.stop_reason === "string" ? body.stop_reason : null,
    },
    usage,
    invocationMetrics: (metrics as Record<string, number> | undefined) ?? null,
    exception: null,
  };
};
