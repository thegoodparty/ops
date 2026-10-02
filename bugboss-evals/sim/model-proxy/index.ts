import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";

import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

import type { ProxyUpstream } from "../../core/adapters/proxy-log";
import type { Rates } from "../../core/price";
import { createProxyCore } from "./proxy";

export interface ModelProxyOptions {
  upstream: ProxyUpstream;
  /**
   * The protocol the system under test speaks. Defaults to the upstream's.
   * `bedrock` on an `anthropic` upstream translates: BugBoss keeps speaking
   * InvokeModel and the eval needs no AWS.
   */
  face?: ProxyUpstream;
  /** Anthropic upstream only. Sent as `x-api-key`; defaults to ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Bedrock only. Defaults to AWS_REGION, then us-west-2. */
  region?: string;
  /** Default 127.0.0.1 on an ephemeral port. */
  listen?: { host: string; port: number };
  /** JSONL, appended per request. */
  logPath: string;
  /** When set, requests past the cap get 402 with a JSON error, and a model with no price is refused. */
  capUsd?: number;
  /** Rates for models `core/price.ts` lacks, such as Anthropic API model ids. */
  rates?: Record<string, Rates>;
  /** Bedrock only. Defaults to this process's credential chain. */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** Tests only: replaces the real upstream. */
  upstreamUrl?: URL;
}

export interface ModelProxy {
  url: string;
  spentUsd(): number;
  requests(): number;
  close(): Promise<void>;
}

/**
 * One listener, whose protocol follows the face: the Bedrock SDK speaks
 * HTTP/2 with prior knowledge to an http:// endpoint, so that face is h2c;
 * the Anthropic SDK and fetch speak HTTP/1.1, so that face is plain http.
 */
export const startModelProxy = async (options: ModelProxyOptions): Promise<ModelProxy> => {
  const region = options.region ?? process.env.AWS_REGION ?? "us-west-2";
  const face = options.face ?? options.upstream;
  const upstreamUrl =
    options.upstreamUrl ??
    (options.upstream === "bedrock"
      ? new URL(`https://bedrock-runtime.${region}.amazonaws.com`)
      : new URL("https://api.anthropic.com"));
  const core = createProxyCore({
    upstream: options.upstream,
    face,
    apiKey: options.upstream === "anthropic" ? (options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null) : null,
    upstreamUrl,
    region,
    credentials: options.credentials ?? fromNodeProviderChain(),
    logPath: options.logPath,
    capUsd: options.capUsd ?? null,
    rates: options.rates ?? {},
  });

  const server =
    face === "bedrock"
      ? http2.createServer((req, res) => void core.handle(req, res))
      : http.createServer((req, res) => void core.handle(req, res));
  const host = options.listen?.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listen?.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    spentUsd: core.spentUsd,
    requests: core.requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) (server as http.Server).closeAllConnections();
      }),
  };
};

/** Env the system under test needs so its SDK talks to the proxy, by the protocol it speaks (the face). */
export const modelProxyEnv = (proxy: ModelProxy, face: ProxyUpstream): Record<string, string> =>
  face === "bedrock" ? { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: proxy.url } : { ANTHROPIC_BASE_URL: proxy.url };
