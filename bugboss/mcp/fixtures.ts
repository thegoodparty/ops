// Test harness for the MCP server. Nothing here reaches S3 or Google.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import jwt from "jsonwebtoken";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Db } from "../db";
import type { McpConfig } from "./config";
import type { FetchLike, GoogleClient, GoogleIdClaims } from "./google";
import type { AgentSession, SessionStore } from "./sessions";
import type {
  HumanBugReport,
  ReportSignal,
  ReportSignalResult,
} from "./tools";

export const MODERN_REVISION = "2026-07-28";
export const PUBLIC_URL = "https://bugboss.test";
export const MCP_URL = `${PUBLIC_URL}/mcp`;
export const GOOGLE_CLIENT_ID = "google-client-id";
export const CLIENT_ID = "https://claude.ai/mcp/client-metadata.json";
export const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

export const testConfig = (overrides: Partial<McpConfig> = {}): McpConfig => ({
  publicUrl: PUBLIC_URL,
  mcpPath: "/mcp",
  jwtSecret: "test-secret-not-a-real-one",
  google: {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: "google-client-secret",
    authorizationEndpoint: "https://accounts.google.test/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.test/token",
  },
  workspaceDomain: "goodparty.org",
  preRegisteredClients: { "cli-client": ["http://127.0.0.1:9999/callback"] },
  accessTokenTtlSeconds: 3600,
  authCodeTtlSeconds: 60,
  flowStateTtlSeconds: 600,
  advertiseOfflineAccess: true,
  ...overrides,
});

/** Swallows puts and reports a cold start, so `Db.open` never touches AWS. */
export const fakeS3 = (): S3Client =>
  ({
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetObjectCommand") {
        const err = new Error("not found");
        err.name = "NoSuchKey";
        throw err;
      }
      return {};
    },
  }) as unknown as S3Client;

export interface SeededIncident {
  id: string;
  status: string;
  rootCause?: string | null;
  usersImpacted?: number | null;
  firstSignalAt?: number;
}

export const openTestDb = async (seed: SeededIncident[] = []): Promise<Db> => {
  const dir = mkdtempSync(join(tmpdir(), "bugboss-mcp-"));
  const db = await Db.open({
    path: join(dir, "test.db"),
    bucket: "bugboss-test",
    key: "state/db",
    s3: fakeS3(),
  });

  if (seed.length > 0) {
    await db.withWrite((sqlite) => {
      const insertIncident = sqlite.prepare(
        `INSERT INTO incident
           (id, status, owner, firstSignalAt, rootCause, usersImpacted,
            resolvedAt, closedAt, postmortem)
         VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?)`,
      );
      const insertSignal = sqlite.prepare(
        `INSERT INTO signal (id, source, sourceId, kind, title, body, openedAt, incidentId)
         VALUES (?, 'grafana', ?, 'alert', ?, ?, ?, ?)`,
      );
      for (const incident of seed) {
        const at = incident.firstSignalAt ?? 1_700_000_000_000;
        // Terminal statuses carry the fields that define them; the schema
        // enforces the pair, so a fixture cannot build a CLOSED incident
        // with no post-mortem.
        const terminal =
          incident.status === "RESOLVED" || incident.status === "CLOSED";
        const closed = incident.status === "CLOSED";
        insertIncident.run(
          incident.id,
          incident.status,
          at,
          incident.rootCause ?? null,
          incident.usersImpacted ?? null,
          terminal ? at : null,
          closed ? at : null,
          closed ? "fixture post-mortem" : null,
        );
        insertSignal.run(
          `sig-${incident.id}`,
          `fingerprint-${incident.id}`,
          `alert for ${incident.id}`,
          "body",
          incident.firstSignalAt ?? 1_700_000_000_000,
          incident.id,
        );
      }
    });
  }

  return db;
};

export const stubSessions = (
  sessions: Record<string, AgentSession> = {},
): SessionStore => ({
  read: async (incidentId) => sessions[incidentId] ?? null,
});

export interface RecordingReporter {
  reportSignal: ReportSignal;
  filed: HumanBugReport[];
}

export const recordingReporter = (
  result: ReportSignalResult = { signalId: "sig-1", incidentId: "inc-1" },
): RecordingReporter => {
  const filed: HumanBugReport[] = [];
  return {
    filed,
    reportSignal: async (report) => {
      filed.push(report);
      return result;
    },
  };
};

export interface FakeGoogle extends GoogleClient {
  /** The nonce the last /authorize handed out. */
  lastNonce: string | null;
  lastState: string | null;
  /** Claims the next exchange mints an id_token for. */
  claims: GoogleIdClaims;
}

export const fakeGoogle = (
  claims: Partial<GoogleIdClaims> = {},
): FakeGoogle => {
  const fake: FakeGoogle = {
    lastNonce: null,
    lastState: null,
    claims: {
      iss: "https://accounts.google.com",
      aud: GOOGLE_CLIENT_ID,
      sub: "google-sub-1",
      exp: Math.floor(Date.now() / 1000) + 600,
      hd: "goodparty.org",
      email: "engineer@goodparty.org",
      email_verified: true,
      name: "An Engineer",
      ...claims,
    },
    authorizationUrl: ({ redirectUri, state, nonce, hd }) => {
      fake.lastNonce = nonce;
      fake.lastState = state;
      const url = new URL("https://accounts.google.test/o/oauth2/v2/auth");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("hd", hd);
      return url.toString();
    },
    exchangeCode: async () => ({
      idToken: jwt.sign(
        { ...fake.claims, nonce: fake.claims.nonce ?? fake.lastNonce },
        "google-signing-key-we-never-check",
      ),
    }),
  };
  return fake;
};

/** A fetch that answers only the URLs given to it. */
export const stubFetch = (
  routes: Record<string, { status?: number; body: string }>,
): FetchLike =>
  async (input) => {
    const route = routes[input];
    if (!route) {
      return { ok: false, status: 404, text: async () => "not found" };
    }
    const status = route.status ?? 200;
    return { ok: status < 400, status, text: async () => route.body };
  };

/**
 * A 2026-07-28 request. Three things make one modern, and the SDK rejects a
 * request missing any of them: the `_meta` envelope in params, the
 * `MCP-Protocol-Version` header, and a `Mcp-Method` header matching the body.
 */
export const modernRequest = (args: {
  method: string;
  params?: Record<string, unknown>;
  token?: string;
  id?: number;
  url?: string;
}): Request => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN_REVISION,
    "Mcp-Method": args.method,
  };
  const name = args.params?.name;
  if (typeof name === "string") headers["Mcp-Name"] = name;
  if (args.token) headers.authorization = `Bearer ${args.token}`;

  return new Request(args.url ?? MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: args.id ?? 1,
      method: args.method,
      params: {
        ...args.params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
          [CLIENT_INFO_META_KEY]: { name: "test-client", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
};

export const jsonRpcResult = async (res: Response) => {
  const body = (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
  return body;
};

/** The JSON a tool packed into its single text content block. */
export const toolPayload = (result: Record<string, unknown>) => {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text) as Record<string, unknown>;
};

export const pkcePair = () => {
  const verifier = randomUUID() + randomUUID();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};
