// Grafana to agent-swarm bridge.
//
// This is the front door for alerts: Grafana posts a notification, and this
// creates a task in the local agent-swarm API. The delivery contract matches
// bugboss/ingress/grafana.ts; what happens after verification does not, because
// agent-swarm has no incident object of its own.
//
// VERIFICATION FAILS CLOSED, and it has to. The endpoint sits behind a public
// ALB, so an unauthenticated delivery would spend agent turns and open work no
// human asked for. A missing or unset secret rejects every delivery rather than
// waving them through, which is the one failure here that must not fail open.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = Number(process.env.PORT ?? 3014)
const STATE_FILE = process.env.STATE_FILE ?? '/state/seen.json'
const TTL_MS = Number(process.env.DEDUP_TTL_HOURS ?? 12) * 60 * 60 * 1000
const WEBHOOK_SECRET = process.env.GRAFANA_WEBHOOK_SECRET
const BASIC_AUTH_PASSWORD = process.env.GRAFANA_BASIC_AUTH_PASSWORD ?? WEBHOOK_SECRET
const API_KEY = process.env.AGENT_SWARM_API_KEY ?? process.env.API_KEY
const API_URL = (process.env.AGENT_SWARM_API_URL ?? 'http://api:3013').replace(/\/+$/, '')

const MAX_BODY_BYTES = 1024 * 1024
// Grafana Cloud's clock and ours are both NTP-disciplined, so a delivery more
// than this far from now is a replay or a misconfiguration, in either direction.
const REPLAY_WINDOW_SECONDS = 300
const TASK_TIMEOUT_MS = 15_000

const SIGNATURE_HEADER = 'x-grafana-alerting-signature'
const TIMESTAMP_HEADER = 'x-grafana-alerting-timestamp'
const INCIDENT_TAG = 'incident'

const PRIORITY_BY_SEVERITY = { critical: 90, high: 75, warning: 50, info: 25, debug: 10 }

const log = (event, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))
}

const str = (value) => (typeof value === 'string' && value.length > 0 ? value : null)

const lower = (value) => {
  const raw = str(value)
  return raw ? raw.trim().toLowerCase() : null
}

const mapping = (value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue
    out[key] = typeof entry === 'string' ? entry : JSON.stringify(entry)
  }
  return out
}

const equal = (a, b) => {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  // timingSafeEqual throws on a length mismatch, so the length is compared
  // first and not in constant time. The length of a hex digest is public.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const freshState = () => ({ nextIncident: 1, seen: {} })

const loadState = () => {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return freshState()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return freshState()
  const nextIncident =
    Number.isInteger(parsed.nextIncident) && parsed.nextIncident > 0 ? parsed.nextIncident : 1
  const seen =
    typeof parsed.seen === 'object' && parsed.seen !== null && !Array.isArray(parsed.seen)
      ? parsed.seen
      : {}
  return { nextIncident, seen }
}

let state = loadState()

const persist = () => {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, STATE_FILE)
}

const prune = (now) => {
  let dropped = 0
  for (const [fingerprint, entry] of Object.entries(state.seen)) {
    if (now - Number(entry.lastSeen ?? 0) > TTL_MS) {
      delete state.seen[fingerprint]
      dropped += 1
    }
  }
  return dropped
}

const priorityFor = (severity) => PRIORITY_BY_SEVERITY[lower(severity)] ?? 50

const verify = (headers, rawBody, now) => {
  if (!WEBHOOK_SECRET) return 'no webhook secret is configured'

  const signature = headers[SIGNATURE_HEADER]
  if (!signature) return 'missing signature header'

  const stamp = headers[TIMESTAMP_HEADER]
  if (!stamp) return 'missing timestamp header'
  const seconds = Number(stamp)
  if (!Number.isFinite(seconds)) return 'timestamp header is not a number'
  if (Math.abs(now / 1000 - seconds) > REPLAY_WINDOW_SECONDS) {
    return 'timestamp outside the replay window'
  }

  const expected = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${stamp}:${rawBody}`, 'utf8')
    .digest('hex')
  if (!equal(String(signature).trim(), expected)) return 'signature mismatch'

  if (!BASIC_AUTH_PASSWORD) return 'no basic auth password is configured'
  const authorization = String(headers['authorization'] ?? '')
  if (!/^basic /i.test(authorization)) return 'missing basic auth'
  const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  // The username is ignored; only the password is checked, which is what the
  // existing gpbot-alert-filter contact point already sends.
  const supplied = colon === -1 ? '' : decoded.slice(colon + 1)
  if (!equal(supplied, BASIC_AUTH_PASSWORD)) return 'basic auth mismatch'
  return null
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new Error('body exceeds the size cap'))
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body exceeds the size cap'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const send = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

// The task's output contract, and the reason it is a schema rather than a request.
//
// agent-swarm rejects a completion whose output does not match this schema, so the
// Slack thread becomes a precondition of finishing the task rather than an
// instruction the agent may skip. Instructions alone did not work: three layers of
// them, the last scoped to this agent and placed in the user turn right after the
// platform's own output instruction, produced no thread and no Slack call at all
// across eight incidents. The same agent follows the task text every time that
// text states a requirement explicitly, so the requirement goes where the agent
// reliably reads it and the platform enforces it.
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    incidentThreadUrl: {
      type: 'string',
      description: 'Permalink to the Slack thread opened for this incident',
    },
    status: {
      type: 'string',
      enum: ['INVESTIGATING', 'FIXING', 'RESOLVED', 'CLOSED', 'MERGED'],
    },
    summary: {
      type: 'string',
      description: 'A few words saying what this incident is, not what was concluded about it',
    },
  },
  required: ['incidentThreadUrl', 'status', 'summary'],
}

// The incident channel, passed in verbatim rather than described.
//
// The first version of this contract told the agent the channel's name and that
// it could read the id from its own environment. It opened the thread in the wrong
// channel instead: a real team channel, because `slack-start-thread` falls back to
// one when the caller does not say. Naming a channel leaves room to guess; an id
// does not.
const INCIDENT_CHANNEL = process.env.SWARM_INCIDENT_CHANNEL ?? ''

// Built per incident so the KV namespace and key are stated as exact values with
// the real number in them. Described in the abstract, the lead wrote
// `namespace=shared, key=incidents/9` where the board jobs read
// `namespace=shared/incidents, key=incident:9`, and a board that reads a namespace
// nobody writes reports nothing while looking healthy.
const reportContract = (incident) => [
  '',
  'Required output',
  '',
  INCIDENT_CHANNEL
    ? `Open a Slack thread in channel ${INCIDENT_CHANNEL} with slack-start-thread, passing that exact channelId, and report in it as you work.`
    : 'Open a Slack thread in the incident channel with slack-start-thread and report in it as you work.',
  'Do not substitute another channel, and do not create one.',
  '',
  'Record the incident in KV with exactly these values, using kv-set:',
  '',
  '  namespace  shared/incidents',
  `  key        incident:${incident}`,
  '',
  `Add ${incident} to the array at namespace shared/incidents, key board:index.`,
  '',
  'When you finish, your task output must be a JSON object matching this schema, and the',
  'task cannot be completed without one:',
  '',
  '  incidentThreadUrl  permalink to the incident thread you opened',
  '  status             exactly one of INVESTIGATING, FIXING, RESOLVED, CLOSED, MERGED',
  '  summary            a few words saying what this incident IS',
  '',
  'No thread permalink means no completion. If you cannot open a thread, say why, and',
  'still record the incident as above.',
]

const fingerprintFor = (alert, labels, annotations) => {
  const declared = str(alert.fingerprint)
  if (declared) return declared
  // Only hand-built payloads omit the fingerprint. Hashing the labels plus the
  // summary keeps a retry of one alert on one incident instead of opening a
  // second, and it is stable across deliveries of the same rule.
  const seed = JSON.stringify({ labels, summary: annotations.summary ?? null })
  return `sha256:${createHash('sha256').update(seed).digest('hex')}`
}

const renderTask = (incident, alert, root, fingerprint) => {
  const labels = {
    ...mapping(root.groupLabels),
    ...mapping(root.commonLabels),
    ...mapping(alert.labels),
  }
  const annotations = {
    ...mapping(root.commonAnnotations),
    ...mapping(alert.annotations),
  }
  const name = labels.alertname ?? str(annotations.summary) ?? 'Grafana alert'
  const status = lower(alert.status) ?? lower(root.status) ?? 'firing'
  const severity = labels.severity ?? null
  const started = str(alert.startsAt) ?? 'unknown'

  const lines = [
    `Incident ${incident}`,
    '',
    `Alert: ${name}`,
    `Status: ${status}`,
    `Severity: ${severity ?? 'unknown'}`,
    `Started: ${started}`,
  ]
  if (str(alert.endsAt)) lines.push(`Ended: ${alert.endsAt}`)

  // The whole alert is the evidence the agent investigates, so nothing in it is
  // cut to a length. A summary trimmed to one line loses the sentence naming
  // the service that is down as readily as it loses noise.
  if (str(annotations.summary)) lines.push('', 'Summary:', annotations.summary)
  if (str(annotations.description)) lines.push('', 'Description:', annotations.description)

  const otherAnnotations = Object.entries(annotations).filter(
    ([key]) => key !== 'summary' && key !== 'description',
  )
  if (otherAnnotations.length > 0) {
    lines.push('', 'Annotations:')
    for (const [key, value] of otherAnnotations) lines.push(`  ${key}: ${value}`)
  }

  const labelEntries = Object.entries(labels)
  if (labelEntries.length > 0) {
    lines.push('', 'Labels:')
    for (const [key, value] of labelEntries) lines.push(`  ${key}: ${value}`)
  }

  if (alert.values && typeof alert.values === 'object' && !Array.isArray(alert.values)) {
    const values = Object.entries(alert.values)
    if (values.length > 0) {
      lines.push('', 'Values:')
      for (const [key, value] of values) lines.push(`  ${key}: ${JSON.stringify(value)}`)
    }
  }

  const links = []
  if (str(alert.generatorURL)) links.push(`  Generator: ${alert.generatorURL}`)
  if (str(alert.dashboardURL)) links.push(`  Dashboard: ${alert.dashboardURL}`)
  if (str(alert.panelURL)) links.push(`  Panel: ${alert.panelURL}`)
  if (str(alert.silenceURL)) links.push(`  Silence: ${alert.silenceURL}`)
  if (str(root.externalURL)) links.push(`  Grafana: ${root.externalURL}`)
  if (links.length > 0) lines.push('', 'Links:', ...links)

  lines.push(...reportContract(incident))

  const machine = {
    incident,
    fingerprint,
    alertname: name,
    status,
    severity,
    receiver: str(root.receiver),
  }
  lines.push('', '--- machine-readable ---', JSON.stringify(machine), '--- end machine-readable ---')

  return lines.join('\n')
}

const createTask = async (task) => {
  const res = await fetch(`${API_URL}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(task),
    signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
  })
  const text = await res.text()
  if (res.status !== 201) {
    throw new Error(`agent-swarm returned HTTP ${res.status}: ${text}`)
  }
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed.id === 'string' ? parsed.id : null
  } catch {
    return null
  }
}

// Best effort only. A repeat that cannot be attached to its task is still a
// recorded note, and failing the delivery over it would make Grafana retry an
// alert the incident already covers.
const steerTask = async (taskId, message) => {
  const res = await fetch(`${API_URL}/api/tasks/${encodeURIComponent(taskId)}/steer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ message, mode: 'queue', onUnsupported: 'degrade', source: 'api' }),
    signal: AbortSignal.timeout(TASK_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`agent-swarm returned HTTP ${res.status} from steer`)
}

const handleGrafana = async (req, res) => {
  let rawBody
  try {
    rawBody = await readBody(req)
  } catch (err) {
    log('rejected', { reason: err.message })
    send(res, 413, { error: err.message })
    return
  }

  const now = Date.now()
  const problem = verify(req.headers, rawBody, now)
  if (problem) {
    log('rejected', { reason: problem })
    send(res, 401, { error: problem })
    return
  }

  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    log('rejected', { reason: 'body was not JSON' })
    send(res, 400, { error: 'body was not JSON' })
    return
  }

  const root = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {}
  const alerts = Array.isArray(payload) ? payload : Array.isArray(root.alerts) ? root.alerts : []
  const deliveryResolved = lower(root.status) === 'resolved'

  const pruned = prune(now)
  if (pruned > 0) log('pruned', { dropped: pruned })

  const summary = { accepted: [], duplicates: [], dropped: [], failed: [] }

  // Grafana posts a top-level ARRAY of alert *groups*, each nesting the alerts
  // that fired for it. Walking that array as if it were a list of alerts never
  // sees a per-alert fingerprint and never splits a group, so one delivery
  // carrying three alerts became one incident, keyed on a hash of the labels the
  // three happened to share.
  //
  // Accept both shapes: an entry that carries its own `alerts` is a group,
  // otherwise the entry is the alert. The group travels with each alert because
  // that is where its common labels and annotations live.
  const units = []
  for (const entry of alerts) {
    if (typeof entry !== 'object' || entry === null) continue
    const members = Array.isArray(entry.alerts) && entry.alerts.length > 0 ? entry.alerts : [entry]
    for (const member of members) {
      if (typeof member !== 'object' || member === null) continue
      units.push({ alert: member, group: entry })
    }
  }

  for (const { alert, group } of units) {
    const labels = {
      ...mapping(root.groupLabels),
      ...mapping(group.groupLabels),
      ...mapping(root.commonLabels),
      ...mapping(group.commonLabels),
      ...mapping(alert.labels),
    }
    const annotations = {
      ...mapping(root.commonAnnotations),
      ...mapping(group.commonAnnotations),
      ...mapping(alert.annotations),
    }
    const fingerprint = fingerprintFor(alert, labels, annotations)
    const status = lower(alert.status) ?? lower(group.status) ?? lower(root.status) ?? 'firing'

    // A resolved notification is dropped outright. An alert that stopped firing
    // does not mean the thing it was about is fixed; it means the symptom went
    // away, and only an agent closes an incident on evidence it went and got.
    if (deliveryResolved || lower(group.status) === 'resolved' || status === 'resolved') {
      summary.dropped.push(fingerprint)
      log('dropped', { fingerprint, reason: 'resolved' })
      continue
    }

    const known = state.seen[fingerprint]
    if (known && now - Number(known.lastSeen ?? 0) <= TTL_MS) {
      // BugBoss models a repeat as a second signal attaching to the incident it
      // already opened. agent-swarm has no signal object, so the repeat is kept
      // as a note on the stored incident and, best effort, handed to the task
      // as a steering message. This is an approximation of that model.
      known.lastSeen = now
      known.count = Number(known.count ?? 1) + 1
      known.notes.push({ at: new Date(now).toISOString(), status, summary: str(annotations.summary) })
      persist()
      if (known.taskId) {
        const note =
          `Alert fired again for Incident ${known.incident} (repeat ${known.count}). ` +
          `Status: ${status}. Summary: ${str(annotations.summary) ?? '(none)'}`
        try {
          await steerTask(known.taskId, note)
        } catch (err) {
          log('surface-failed', { incident: known.incident, fingerprint, error: err.message })
        }
      }
      summary.duplicates.push(known.incident)
      log('duplicate', { incident: known.incident, fingerprint, count: known.count })
      continue
    }

    const incident = state.nextIncident
    const task = {
      task: renderTask(incident, alert, group, fingerprint),
      source: 'api',
      tags: [INCIDENT_TAG, `${INCIDENT_TAG}:${incident}`, 'alert'],
      priority: priorityFor(labels.severity),
      contextKey: fingerprint,
      outputSchema: OUTPUT_SCHEMA,
    }

    let taskId
    try {
      taskId = await createTask(task)
    } catch (err) {
      // The fingerprint is deliberately not recorded, so a retry of this same
      // delivery can still open the incident it failed to open now.
      summary.failed.push(fingerprint)
      log('failed', { incident, fingerprint, error: err.message })
      continue
    }

    state.seen[fingerprint] = {
      incident,
      taskId,
      firstSeen: now,
      lastSeen: now,
      count: 1,
      notes: [],
    }
    state.nextIncident = incident + 1
    persist()
    summary.accepted.push(incident)
    log('accepted', { incident, fingerprint, taskId })
  }

  if (summary.failed.length > 0) {
    // Non-2xx so Grafana retries. Alerts that already succeeded are in the
    // seen-set by now, so the retry re-opens only the ones that failed.
    send(res, 500, { error: 'one or more incidents could not be created', ...summary })
    return
  }
  send(res, 202, summary)
}

// The whole delivery is serialized so incident allocation and the state file
// have a single writer, which is what keeps the numbering dense and
// deterministic even when Grafana delivers two alerts at once.
let queue = Promise.resolve()
const serialize = (fn) => {
  const run = queue.then(fn)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && url.pathname === '/grafana') {
    serialize(() => handleGrafana(req, res)).catch((err) => {
      log('error', { error: err.message })
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
    return
  }

  send(res, 404, { error: 'not found' })
})

process.on('unhandledRejection', (reason) => {
  log('unhandled-rejection', { error: reason instanceof Error ? reason.message : String(reason) })
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  log('uncaught-exception', { error: err.message })
  process.exit(1)
})

if (!WEBHOOK_SECRET) {
  log('misconfigured', {
    missing: 'GRAFANA_WEBHOOK_SECRET',
    note: 'every delivery is rejected until it is set',
  })
}
if (!API_KEY) {
  log('misconfigured', { missing: 'AGENT_SWARM_API_KEY', note: 'task creation fails until it is set' })
}

server.listen(PORT, '0.0.0.0', () => {
  log('listening', { port: PORT, stateFile: STATE_FILE, api: API_URL })
})
