import axios from "axios";
import dayjs from "dayjs";

type LokiStreamResult = {
  stream: Record<string, string>;
  values: [string, string][];
};

type LokiResponse = {
  data: {
    resultType: string;
    result: LokiStreamResult[];
  };
};

export type GrafanaLogEntry = {
  timestamp: string;
  line: string;
  labels: Record<string, string>;
};

export const searchGrafanaLogs = async (
  logql: string,
  options?: { limit?: number; since?: string }
): Promise<GrafanaLogEntry[]> => {
  const token = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;

  if (!token) {
    console.log(
      "Skipping Grafana search (GRAFANA_SERVICE_ACCOUNT_TOKEN not set)"
    );
    return [];
  }

  const params: Record<string, string | number> = {
    query: logql,
    limit: options?.limit ?? 100,
    direction: "backward",
    start: options?.since ?? dayjs().subtract(1, "week").toISOString(),
  };

  const response = await axios.get<LokiResponse>(
    `https://goodparty.grafana.net/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query_range`,
    {
      params,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.data.data.result.flatMap((stream) =>
    stream.values.map(([timestamp, line]) => ({
      timestamp,
      line,
      labels: stream.stream,
    }))
  );
};
