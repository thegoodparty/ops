import axios from "axios";

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const DATABRICKS_HOST = "https://dbc-3d8ca484-79f3.cloud.databricks.com";

const client = axios.create({
  baseURL: `${DATABRICKS_HOST}/api/2.0/genie`,
  headers: {
    Authorization: `Bearer ${process.env.DATABRICKS_TOKEN}`,
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pollMessage = async (
  spaceId: string,
  conversationId: string,
  messageId: string,
) => {
  let delay = 1000;
  const maxWait = 5 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const { data: msg } = await client.get(
      `/spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}`,
    );
    const status = msg.status;

    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED")
      return msg;

    await sleep(delay);
    delay = Math.min(delay * 1.5, 10000);
  }

  fail("Timed out waiting for Genie response (5 min)");
};

const main = async () => {
  const spaceId = "01f0f70dd27512e1b316ca9fdefc6ce8";
  const question = process.argv.slice(2).join(" ");
  if (!question) fail("Usage: genie <question>");

  const { data: conversation } = await client.post(
    `/spaces/${spaceId}/start-conversation`,
    { content: question },
  );

  const conversationId = conversation.conversation_id;
  const messageId = conversation.message_id;

  const genieUrl = `${DATABRICKS_HOST}/genie/rooms/${spaceId}/chats/${conversationId}`;
  console.log(`View in Databricks: ${genieUrl}\n`);

  const result = await pollMessage(spaceId, conversationId, messageId);

  if (result.status !== "COMPLETED") {
    fail(
      `Genie query failed with status: ${result.status}\n${JSON.stringify(result.error ?? result, null, 2)}`,
    );
  }

  const attachments = result.attachments ?? [];
  for (const attachment of attachments) {
    if (attachment.text?.content) {
      console.log(attachment.text.content);
    }

    if (attachment.query?.query) {
      console.log("\n--- Generated SQL ---");
      console.log(attachment.query.query);
    }

    if (attachment.attachment_id) {
      const { data: queryResult } = await client.get(
        `/spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}/attachments/${attachment.attachment_id}/query-result`,
      );

      const columns: { name: string }[] =
        queryResult.statement_response?.manifest?.schema?.columns ?? [];
      const chunks: { data_array: string[][] }[] = queryResult
        .statement_response?.result?.data_array
        ? [{ data_array: queryResult.statement_response.result.data_array }]
        : (queryResult.statement_response?.result?.chunk_iterator ?? []);

      if (columns.length > 0) {
        const rows: string[][] = [];
        for (const chunk of chunks) {
          if (chunk.data_array) rows.push(...chunk.data_array);
        }

        const header = columns.map((c) => c.name);
        const widths = header.map((h, i) =>
          rows.reduce((max, r) => Math.max(max, (r[i] ?? "").length), h.length),
        );
        const pad = (s: string, w: number) => s.padEnd(w);

        console.log("\n--- Results ---");
        console.log(header.map((h, i) => pad(h, widths[i])).join(" | "));
        console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
        for (const row of rows) {
          console.log(row.map((v, i) => pad(v ?? "", widths[i])).join(" | "));
        }
        console.log(`\n(${rows.length} rows)`);
      }
    }
  }
};

main().catch((err) => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
