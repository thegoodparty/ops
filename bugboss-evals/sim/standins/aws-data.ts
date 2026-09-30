export interface MetricDatapoint {
  ts: number;
  value: number;
}

export interface AwsData {
  cloudwatch: {
    namespace: string;
    metricName: string;
    dimensions: Record<string, string>;
    unit: string;
    datapoints: MetricDatapoint[];
  }[];
  ecs: {
    clusters: string[];
    services: {
      cluster: string;
      name: string;
      desiredCount: number;
      runningCount: number;
      taskDefinition: string;
    }[];
  };
  secretsManager: { names: string[] };
}
