#!/usr/bin/env bash
set -euo pipefail

api=0
if curl -fsS -m 5 -o /dev/null http://127.0.0.1:3013/health; then api=1; fi

public=0
if curl -fsS -m 10 -o /dev/null https://swarm.goodparty.org/health; then public=1; fi

disk="$(df --output=pcent / | tail -n 1 | tr -dc '0-9')"

aws cloudwatch put-metric-data --region us-west-2 --namespace AgentSwarm --metric-data \
  "MetricName=ApiHealthy,Value=$api,Unit=None" \
  "MetricName=PublicHealthy,Value=$public,Unit=None" \
  "MetricName=DiskUsedPercent,Value=$disk,Unit=Percent"
