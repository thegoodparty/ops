// The process resume.test.mts kills. It starts an incident run on SQLite and
// prints READY once both tools of the second round are mid-execution.

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { context, openSpikeHarness } from "./harness.mts";

const [databasePath, executionLog] = process.argv.slice(2);

const faux = fauxProvider();
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("slow_query", { query: "first" }, { id: "q1" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage(
    [
      fauxToolCall("slow_query", { query: "second" }, { id: "q2" }),
      fauxToolCall("monitor", { what: "the deploy" }, { id: "m1" }),
    ],
    { stopReason: "toolUse" },
  ),
]);
const models = createModels();
models.setProvider(faux.provider);

const { harness, incident } = await openSpikeHarness(await openNodeSqliteStorage(databasePath), models, {
  executionLog,
  slowQueryMs: (query) => (query === "second" ? 600_000 : 0),
  monitorMs: 600_000,
  monitorStarted: () => {
    // Long enough for slow_query's intent and the monitor's intent to commit.
    setTimeout(() => process.stdout.write("READY\n"), 300);
  },
});

const conversation = await harness.createConversation(
  {
    ownership: { kind: "ownerless" },
    agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [incident] },
  },
  context,
);
process.stdout.write(`CONVERSATION ${conversation.id}\n`);
await conversation.submit(
  { type: "input", content: "incident 7: 500s on /v1/campaigns", requestId: "incident-7:signal-1" },
  context,
);
await new Promise(() => {});
