# Pointing Grafana at the swarm

BugBoss already receives every alert through the `dev-alerts` contact point. To
let the swarm see the same alerts without disturbing BugBoss, add a **second
webhook integration to that same contact point**. Grafana fans a contact point
out to every integration on it, so both systems get every alert and each fails
independently.

This is a UI step, on purpose. See "Why not the API" at the bottom.

## Before you start

Back up the current contact points, the way the policy tree was backed up:

```bash
curl -sS -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  "https://goodparty.grafana.net/api/v1/provisioning/contact-points" \
  > "agent-swarm/grafana/contact-points-backup-$(date +%Y%m%d).json"
```

## The values to paste

Alerting → **Contact points** → open **`dev-alerts`** → **Add contact point
integration** → choose **Webhook**.

| Field | Value |
| --- | --- |
| URL | `https://agent-swarm.goodparty.org/grafana` |
| HTTP method | `POST` |
| Max alerts | `0` |
| Disable resolved message | checked |
| Username | `agent-swarm` |
| Password | the `GRAFANA_BASIC_AUTH_PASSWORD` value below |
| HMAC signature header | `X-Grafana-Alerting-Signature` |
| HMAC timestamp header | `X-Grafana-Alerting-Timestamp` |
| HMAC secret | the `GRAFANA_WEBHOOK_SECRET` value below |

Read those two values fresh from Secrets Manager, without echoing the rest of
the blob:

```bash
aws secretsmanager get-secret-value --secret-id AGENT_SWARM --region us-west-2 \
  --query SecretString --output text \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('secret:', d['GRAFANA_WEBHOOK_SECRET']); print('password:', d['GRAFANA_BASIC_AUTH_PASSWORD'])"
```

Save the contact point. **Do not touch the existing webhook integration**, which
points at `https://bugboss.goodparty.org/grafana`. Both integrations live side by
side.

## Why each setting matters

- **Max alerts 0.** Any other value silently truncates a burst, and a truncated
  burst is indistinguishable from a quiet one. BugBoss's integration is set to 0
  for the same reason.
- **Disable resolved message.** The bridge drops resolve deliveries by design: an
  alert that stopped firing has not stopped mattering, because the symptom going
  away is not the cause being handled. Sending them would only add noise.
- **Both HMAC headers.** The signature is computed over
  `"<timestamp>:<body>"`, so the timestamp must travel with it or the bridge
  cannot verify anything. A third-party header name means the signature arrives
  under a name the bridge does not read, and every delivery is rejected.
- **The secret must match.** The bridge verifies with
  `GRAFANA_WEBHOOK_SECRET` from the `AGENT_SWARM` secret and **fails closed**: a
  mismatch rejects every delivery rather than accepting any. If alerts appear to
  arrive and nothing happens, check this first, then the bridge's log.

## Verify it works

The bridge is verifiable without Grafana. From inside the host:

```bash
# reach the host
aws ssm start-session --target "$(aws ec2 describe-instances --region us-west-2 \
  --filters 'Name=tag:Name,Values=agent-swarm' 'Name=instance-state-name,Values=running' \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)"

# then, on the host
docker compose -f /opt/agent-swarm/docker-compose.yml logs --tail=50 bridge
curl -sS https://agent-swarm.goodparty.org/health
```

A test alert that does not require a real incident:

```bash
./agent-swarm/grafana/send-test-alert.sh https://agent-swarm.goodparty.org
```

It signs a synthetic payload with the same secret the integration will use, so a
successful run proves the whole path from signature to created task.

## Why not the API

The obvious move is `PUT /api/v1/provisioning/contact-points/<uid>`. Do not.
This Grafana reports its contact points through that endpoint in a flattened
legacy shape: two contact points both named `dev-alerts`, an empty `integrations`
array on every row, and a 404 when you fetch one by uid. That shape cannot
express a contact point holding two integrations, so a `PUT` built from it would
either drop the existing Slack and BugBoss integrations or be refused outright.
Alerting is a live path, so the change goes through the UI where the result is
visible, after a backup.
