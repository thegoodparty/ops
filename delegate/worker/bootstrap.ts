// Loaded via `node --require` before entrypoint.ts. Expands the single
// DELEGATES JSON secret (mounted by ECS as one env var) into individual
// per-key env vars so modules that read `process.env.X` at import time
// (e.g. framework/mcp.ts) see the values.
//
// This must stay synchronous and import-free so it can run before any
// application module is loaded.

const raw = process.env.DELEGATES_JSON;
if (!raw) {
  console.error(
    "bootstrap: DELEGATES_JSON env var is missing — secret was not mounted",
  );
  process.exit(1);
}

let parsed: Record<string, unknown>;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error("bootstrap: DELEGATES_JSON is not valid JSON:", err);
  process.exit(1);
}

for (const [key, value] of Object.entries(parsed)) {
  if (process.env[key] !== undefined) continue;
  if (typeof value === "string") {
    process.env[key] = value;
  } else if (value != null) {
    process.env[key] = JSON.stringify(value);
  }
}

delete process.env.DELEGATES_JSON;
