import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * The Databricks CLI in the agent images, checked against the files a deploy
 * reads.
 *
 * The swarm reaches the warehouse through one profile, `delegate-sql`, whose
 * credentials arrive as injected secrets (DATABRICKS_HOST, DATABRICKS_CLIENT_ID,
 * DATABRICKS_CLIENT_SECRET) and never enter the image. Two halves of that can
 * break silently, and both are invisible until someone runs a query:
 *
 * 1. the CLI is installed without a version or checksum pin, so a build picks up
 *    a different release than the one the service principal was verified
 *    against, and
 * 2. a credential is written into /etc/databrickscfg, where it is baked into an
 *    image that every agent container reads.
 *
 * The profile itself is load-bearing: without `--profile delegate-sql` the CLI
 * requests the all-apis scope and this service principal rejects the token, so
 * a profile that disappeared from the config would look like an access problem.
 *
 * Everything here reads local files; no network, no Docker.
 */

const HOST_DIR = path.resolve(__dirname, '..')
const DOCKERFILE = path.join(HOST_DIR, 'worker-patch', 'Dockerfile')
const COMPOSE = path.join(HOST_DIR, 'docker-compose.yml')

const read = (file: string): string => fs.readFileSync(file, 'utf8')

/** The profile name the verified runtime used (Swain Molster, 2026-11-25). */
const PROFILE = 'delegate-sql'
const CLI_VERSION = '1.28.0'
const CONFIG_PATH = '/etc/databrickscfg'

describe('databricks CLI in the worker image', () => {
  it('installs the pinned release, from a checksum, onto the worker PATH', () => {
    const source = read(DOCKERFILE)
    // /usr/local/bin is on the worker PATH; a $HOME install dies with the
    // container, and /root/.local is invisible to the worker.
    assert.match(
      source,
      /^\s*install -m 0755 "\$tmp\/databricks" \/usr\/local\/bin\/databricks; \\$/m,
      'the CLI must be installed to a directory on the worker PATH (/usr/local/bin)',
    )
    assert.ok(
      source.includes(`ARG DATABRICKS_CLI_VERSION=${CLI_VERSION}`),
      `worker-patch must pin DATABRICKS_CLI_VERSION=${CLI_VERSION}; a floating version installs whatever is latest`,
    )
    // The download URL must derive from the pin, not restate a literal.
    assert.ok(
      source.includes(
        'databricks_cli_${DATABRICKS_CLI_VERSION}_linux_${arch}.zip',
      ),
      'the release URL must be built from DATABRICKS_CLI_VERSION so a bump moves both halves',
    )
    assert.match(
      source,
      /sha256sum -c -/,
      'the build must verify the release against its published checksum',
    )
    // Two arch entries, each a real SHA-256 (the release ships one per
    // platform, so a build on the other arch cannot silently skip the check).
    for (const arch of ['amd64', 'arm64']) {
      const match = source.match(
        new RegExp(`\\b${arch};\\s*sha=([0-9a-f]{64})`),
      )
      assert.ok(match, `no pinned SHA-256 for linux_${arch}`)
    }
    assert.match(
      source,
      new RegExp(
        `databricks version \\| sed -n 's\\/\\^Databricks CLI v\\/\\/p'.*DATABRICKS_CLI_VERSION`,
      ),
      'the build must fail when the installed binary is not the pinned version',
    )
  })

  it('writes the delegate-sql profile, and no credentials, into the image', () => {
    const source = read(DOCKERFILE)
    const block = source.match(
      new RegExp(`printf '%s\\\\n'([\\s\\S]*?)> ${CONFIG_PATH}`),
    )
    assert.ok(block, `worker-patch must write ${CONFIG_PATH}`)
    const written = block[1]
    for (const line of [`[${PROFILE}]`, 'auth_type = oauth-m2m', 'scopes = sql']) {
      assert.ok(
        written.includes(`'${line}'`),
        `${CONFIG_PATH} must carry "${line}"; the m2m-only sql scope is what this service principal accepts`,
      )
    }
    // Nothing secret in the image: these three are injected as secrets, and
    // any of them in the config would be baked in and read by every agent.
    for (const key of ['host', 'client_id', 'client_secret', 'token', 'password']) {
      assert.ok(
        !new RegExp(`^\\s*'${key}\\s*=`, 'm').test(written),
        `${key} must not be written into ${CONFIG_PATH}`,
      )
    }
    // A home-relative path would also be wrong for a different reason: this
    // hook runs as root (root's $HOME) and no agent home is a volume.
    assert.ok(
      !source.includes('$HOME/.databrickscfg') && !source.includes('/root/.databrickscfg'),
      'the config must not live under a home directory',
    )
  })

  it('points every agent at that config file', () => {
    const source = read(DOCKERFILE)
    assert.ok(
      source.includes(`ENV DATABRICKS_CONFIG_FILE=${CONFIG_PATH}`),
      `the image must pin DATABRICKS_CONFIG_FILE=${CONFIG_PATH}`,
    )
    // The default path is ~/.databrickscfg; unpinned, the profile is not found
    // and the CLI falls back to a scope this service principal rejects.
    const compose = read(COMPOSE)
    assert.ok(
      !compose.includes('DATABRICKS_CONFIG_FILE'),
      'docker-compose.yml must not override DATABRICKS_CONFIG_FILE: the image sets it once',
    )
  })

  it('ships on the one image all three agent containers run', () => {
    // "Every image" is one image in this swarm: lead, coder and reviewer share
    // x-worker-base, which up.sh builds from worker-patch. A fourth agent
    // service added with its own image would not get the CLI.
    const compose = read(COMPOSE)
    const services = [...compose.matchAll(/^ {2}([a-z-]+):\n {4}<<: \*worker-base$/gm)]
      .map((m) => m[1])
    assert.deepEqual(
      services.sort(),
      ['lead', 'worker-coder', 'worker-reviewer'],
      'the agent services inheriting the patched image changed; check they all still get the CLI',
    )
  })
})
