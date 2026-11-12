import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * The worker's agent-browser stack health helper, checked by running it.
 *
 * The helper exists because a live browser was repeatedly read as dead: the
 * dashboard's `/api/sessions` answers 403 to any Origin other than
 * `http://127.0.0.1:<port>`, so a probe without Host/Origin/Referer looks
 * exactly like a browser that is not running. One night that produced four
 * revive tasks plus two superseded dispatches. The helper separates the two
 * cases with distinct exit codes, and the point of these tests is that the
 * codes, and the headers they depend on, are the ones the deploy installs.
 *
 * Nothing here reads the script as documentation: the source is extracted out
 * of `global-setup-script.sh` the way `sync-agent-config.sh` extracts the
 * `models.json` heredoc, written to a temp file and executed against a stub
 * `PATH` and a real `node:http` server. A helper that drifts from the deploy,
 * or a heredoc that mangles the script's own quoting, fails here.
 */

const HOST_DIR = path.resolve(__dirname, '..')
const SETUP_SCRIPT = path.join(HOST_DIR, 'global-setup-script.sh')
const INSTALLED_AS = '/usr/local/bin/agent-browser-stack-health'

const read = (file: string): string => fs.readFileSync(file, 'utf8')

/**
 * The helper body out of the setup script, using the same awk program shape
 * `sync-agent-config.sh` uses for the `models.json` heredoc: turn on at the
 * heredoc's opening line, off at its delimiter.
 */
const helperSource = (source = read(SETUP_SCRIPT)): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-health-src-'))
  try {
    const copy = path.join(dir, 'global-setup-script.sh')
    fs.writeFileSync(copy, source)
    const extracted = spawnSync(
      'awk',
      ["/<<'HEALTH'$/{on=1; next} /^HEALTH$/{on=0} on", copy],
      { encoding: 'utf8' },
    )
    assert.equal(extracted.status, 0, `awk could not read the HEALTH heredoc: ${extracted.stderr}`)
    return extracted.stdout
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const hasTool = (tool: string): boolean =>
  spawnSync('bash', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0

const missingTools = ['bash', 'awk', 'curl', 'jq'].filter((tool) => !hasTool(tool))
const skip = missingTools.length ? `needs ${missingTools.join(', ')} on PATH` : false

type Run = { status: number | null; stdout: string; stderr: string }

const stdoutLines = (stdout: string): string[] => stdout.split('\n').filter((line) => line.trim() !== '')

const writeExec = (file: string, body: string): void => {
  fs.writeFileSync(file, body, { mode: 0o755 })
}

/** Runs the helper as the deploy would, with a stub `PATH` and a scratch `HOME`. */
const runHelper = (opts: { port: number; chrome: boolean }): Promise<Run> => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-health-bin-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-health-home-'))
  const helper = path.join(bin, 'agent-browser-stack-health')
  writeExec(helper, helperSource())
  writeExec(
    path.join(bin, 'pgrep'),
    opts.chrome ? '#!/bin/bash\nprintf "4242\\n"\n' : '#!/bin/bash\nexit 1\n',
  )
  writeExec(path.join(bin, 'agent-browser'), '#!/bin/bash\necho "no sessions"\n')

  return new Promise<Run>((resolve) => {
    const child = spawn(helper, [], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        AGENT_BROWSER_PORT: String(opts.port),
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('close', (status) => {
      fs.rmSync(bin, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
      resolve({ status, stdout, stderr })
    })
  })
}

/**
 * A dashboard stand-in on a real socket, so the probe runs the deploy's `curl`
 * and the assertions can see the headers it sent.
 */
const withDashboard = async <T>(
  status: 200 | 403,
  fn: (port: number, requests: http.IncomingHttpHeaders[]) => Promise<T>,
): Promise<T> => {
  const requests: http.IncomingHttpHeaders[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.headers)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(
      status === 200 ? JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) : '{"error":"forbidden"}',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'the dashboard stand-in has no port')
  try {
    return await fn(address.port, requests)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** A port nothing is listening on, for the "the API is gone too" case. */
const deadPort = async (): Promise<number> => {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const parseOne = (run: Run): Record<string, any> => {
  const lines = stdoutLines(run.stdout)
  assert.equal(lines.length, 1, `expected exactly one line of stdout, got ${lines.length}: ${run.stdout}`)
  return JSON.parse(lines[0]) as Record<string, any>
}

describe('agent-browser stack health heredoc', () => {
  it('extracts the helper out of the setup script with its quoting intact', () => {
    const body = helperSource()
    assert.ok(body.startsWith('#!/usr/bin/env bash\n'), 'the helper no longer starts with a bash shebang')
    assert.ok(
      body.includes(`trap 'rm -f "$body"' EXIT`),
      "the quoted heredoc must keep the helper's single quotes literal; the deploy shell would expand them otherwise",
    )
  })

  it('is installed only where agent-browser exists, and made executable', () => {
    const source = read(SETUP_SCRIPT)
    const start = source.indexOf(`cat >${INSTALLED_AS} <<'HEALTH'`)
    assert.ok(start >= 0, `global-setup-script.sh does not write ${INSTALLED_AS}`)
    const before = source.slice(0, start).split('\n').filter((line) => line.trim() !== '')
    assert.equal(
      before[before.length - 1].trim(),
      'if command -v agent-browser >/dev/null 2>&1; then',
      'the helper must be guarded by `command -v agent-browser`, or a worker without a browser gets a tool it cannot use',
    )
    assert.ok(
      source.slice(start).includes(`chmod 755 ${INSTALLED_AS}\nfi\n`),
      'the guard must close right after chmod 755, or the install runs on every container regardless of agent-browser',
    )
  })
})

describe('agent-browser stack health contract', { skip }, () => {
  it('exits 2 with no chrome for the profile', async () => {
    const run = await runHelper({ port: await deadPort(), chrome: false })
    assert.equal(run.status, 2, `no chrome must be exit 2, not ${run.status}`)
    const report = parseOne(run)
    assert.equal(report.verdict, 'no-chrome')
    assert.equal(report.exitCode, 2)
    assert.equal(report.chrome.pid, '-')
  })

  it('exits 0 with one JSON line and the session count when chrome and the API are up', async () => {
    await withDashboard(200, async (port, requests) => {
      const run = await runHelper({ port, chrome: true })
      assert.equal(run.status, 0, `a healthy stack must be exit 0, not ${run.status}: ${run.stderr}`)
      const report = parseOne(run)
      assert.equal(report.verdict, 'ok')
      assert.equal(report.exitCode, 0)
      assert.equal(report.chrome.pid, '4242')
      assert.equal(report.api.status, '200')
      // jq receives it as --arg, so it travels as a string; what matters is the count.
      assert.equal(report.api.sessionCount, '3', 'the report must carry the session count')
      assert.equal(report.port, String(port), 'the probe must use AGENT_BROWSER_PORT')
      assert.equal(report.profile, 's2w-login', 'the profile default is part of the contract')

      // The whole reason the helper exists: the probe must look local.
      assert.equal(requests.length, 1, 'one snapshot, one API call')
      assert.equal(requests[0].origin, `http://127.0.0.1:${port}`)
      assert.equal(requests[0].referer, `http://127.0.0.1:${port}/`)
      assert.equal(requests[0].host, `127.0.0.1:${port}`)
    })
  })

  it('exits 3 when chrome is alive but the API answers 403', async () => {
    await withDashboard(403, async (port) => {
      const run = await runHelper({ port, chrome: true })
      assert.equal(
        run.status,
        3,
        `a refused probe with chrome alive must be exit 3 (not 2, which relaunches a live browser), got ${run.status}`,
      )
      const report = parseOne(run)
      assert.equal(report.verdict, 'api-not-200')
      assert.equal(report.exitCode, 3)
      assert.equal(report.chrome.pid, '4242', 'exit 3 must still report the live browser')
      assert.equal(report.api.status, '403')
    })
  })
})
