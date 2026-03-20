import type { McpServerConfig } from "./types";

export const mcpServers = {
  grafana: {
    command: "uvx",
    args: ["mcp-grafana"],
    env: {
      GRAFANA_URL: "https://goodparty.grafana.net",
      GRAFANA_SERVICE_ACCOUNT_TOKEN:
        process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN ?? "",
    },
  },
} satisfies Record<string, McpServerConfig>;
