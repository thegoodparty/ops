import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * The Delegate Agent Swarm's inference residency rule, checked against the
 * files a deploy actually reads. `agent-swarm/host/` is uploaded to the host
 * verbatim (`agent-swarm/README.md`, "How it deploys"), so these four files are
 * the whole posture:
 *
 * - `global-setup-script.sh` carries the pi harness's `models.json` as a
 *   heredoc. It is the only artifact that reaches the agent container, so it
 *   is the pinned copy; there is no second file to drift from.
 * - `render-env.sh` names the model every agent runs.
 * - `docker-compose.yml` is what actually passes `FIREWORKS_API_KEY` and
 *   `PI_CODING_AGENT_DIR` into the worker, because compose enumerates env
 *   vars and a key in `.env` that compose does not list never arrives.
 *
 * The rule is `docs/bifrost-gateway.md`, "Inference residency", and it needs
 * BOTH halves. Either one alone is wrong, and each one alone looks configured:
 *
 * 1. the endpoint must be the US host (`https://us.api.fireworks.ai/inference`),
 *    not the global `https://api.fireworks.ai/inference`, and
 * 2. the model id must be a US-only router
 *    (`accounts/fireworks/routers/<model>-us`), not a global model id.
 *
 * This mirrors the intent of `deploy-workbench/bifrost/config.test.ts`
 * (`SERVED_MODEL_CLASSES` and `US_FIREWORKS_ROUTER`), which enforces the same
 * two halves for the gateway. It reads local files only and needs no network.
 */

const HOST_DIR = path.resolve(__dirname, '..')
const SETUP_SCRIPT = path.join(HOST_DIR, 'global-setup-script.sh')
const RENDER_ENV = path.join(HOST_DIR, 'render-env.sh')
const COMPOSE = path.join(HOST_DIR, 'docker-compose.yml')
const SYNC_AGENT_CONFIG = path.join(HOST_DIR, 'sync-agent-config.sh')

/** A US-only Fireworks router id, and nothing else: not a global model id. */
const US_FIREWORKS_ROUTER = /^accounts\/fireworks\/routers\/[a-z0-9.-]+-us$/

/** The one permitted model, pinned as a literal so a silent swap fails a test. */
const US_ROUTER_ID = 'accounts/fireworks/routers/deepseek-v4p1-flash-1017-us'

/** The US-only host, and the global host that must not appear. */
const US_BASE_URL = 'https://us.api.fireworks.ai/inference'
const US_HOST = 'us.api.fireworks.ai'
const GLOBAL_HOST = 'api.fireworks.ai'

/**
 * Every Fireworks host a source mentions, as hostnames. Substring matching is
 * wrong here: `us.api.fireworks.ai` contains `api.fireworks.ai`, so a naive
 * `includes` reports every correct US URL as a global one. The negative
 * lookbehind is what distinguishes the two.
 */
const fireworksHosts = (source: string): string[] =>
  source.match(/(?<![\w.-])api\.fireworks\.ai/g) ?? []

/** The provider id models.json defines. Not the built-in `fireworks`; see the test below. */
const PROVIDER_ID = 'fireworks-us'

const read = (file: string): string => fs.readFileSync(file, 'utf8')

/**
 * Every file under `host/`, so the whole-file checks are not limited to the
 * three the other tests name. A new script that reintroduces a global id is
 * then caught without this test having to know about it.
 */
const hostFiles = (): string[] => {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      // A test that asserts the rule has to be able to quote the forbidden
      // shapes, so test files are not themselves scanned. They are inert: no
      // deploy executes them.
      else if (!entry.name.endsWith('.test.ts')) out.push(full)
    }
  }
  walk(HOST_DIR)
  return out
}

/**
 * The `models.json` heredoc out of the setup script. Extracted rather than
 * kept as a second file because the setup script is the only artifact that
 * reaches the container: a checked-in `models.json` beside it would be dead
 * config that could disagree with what is deployed.
 */
const modelsJsonSource = (): string => {
  const source = read(SETUP_SCRIPT)
  const match = source.match(/<<'PI_MODELS_JSON'\n([\s\S]*?)\nPI_MODELS_JSON\n/)
  assert.ok(match, 'global-setup-script.sh has no PI_MODELS_JSON heredoc')
  return match[1]
}

type Model = {
  id: string
  api?: string
  reasoning?: boolean
  input?: string[]
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow?: number
  maxTokens?: number
}

type ModelsConfig = {
  providers: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: Model[] }>
}

const loadModels = (): ModelsConfig => JSON.parse(modelsJsonSource()) as ModelsConfig

const provider = (config: ModelsConfig, name: string) => {
  const found = config.providers[name]
  assert.ok(found, `models.json has no ${name} provider`)
  return found
}

/** Every Fireworks-looking model id a file mentions, in any quoting style. */
const fireworksIds = (source: string): string[] =>
  source.match(/accounts\/fireworks\/[A-Za-z0-9./_-]+/g) ?? []

describe('agent-swarm inference residency', () => {
  it('is valid JSON, so agent-swarm can compose it', () => {
    // agent-swarm reads this file with JSON.parse in writeSessionModelsJson. A
    // comment here (models.json is JSONC to pi) would make agent-swarm drop the
    // provider blocks it composes, so the rationale lives in the setup script's
    // comment and this file has to stay plain JSON.
    assert.doesNotThrow(() => JSON.parse(modelsJsonSource()))
  })

  it('points the one provider at the US-only endpoint', () => {
    const config = loadModels()
    const configured = provider(config, PROVIDER_ID)
    assert.equal(
      configured.baseUrl,
      US_BASE_URL,
      `the ${PROVIDER_ID} provider must point at the US-only endpoint`,
    )
    assert.equal(
      new URL(configured.baseUrl).host,
      'us.api.fireworks.ai',
      'the Fireworks endpoint must be the US-only host, not the global api.fireworks.ai',
    )
  })

  it('serves exactly one model, and it is the US-only 1017 router', () => {
    const config = loadModels()
    const configured = provider(config, PROVIDER_ID)
    const models = configured.models ?? []
    assert.equal(
      models.length,
      1,
      'the swarm runs exactly one model; adding one is a residency and cost decision, not a convenience',
    )
    assert.equal(models[0].id, US_ROUTER_ID)
    assert.match(
      models[0].id,
      US_FIREWORKS_ROUTER,
      `the served id must be a US-only router (accounts/fireworks/routers/<model>-us)`,
    )
    // The wire shape pi needs to drive it through the Anthropic Messages API.
    assert.equal(models[0].api, 'anthropic-messages')
    assert.equal(models[0].reasoning, true)
    assert.deepEqual(models[0].input, ['text', 'image'])
    assert.equal(models[0].contextWindow, 1000000)
    assert.equal(models[0].maxTokens, 384000)
  })

  it('prices the model at the US-only rate, not the global one', () => {
    // US-only Serverless is 1.5x the global endpoint: $0.45 in / $0.009 cached
    // / $1.80 out per 1M tokens (docs/bifrost-gateway.md, "The Fireworks
    // premium"). pi's built-in catalog carries .3 / .006 / 1.2 for the -1017
    // entries, so copying it would under-report the bill by a third.
    const model = provider(loadModels(), PROVIDER_ID).models![0]
    assert.deepEqual(model.cost, {
      input: 0.45,
      output: 1.8,
      cacheRead: 0.009,
      cacheWrite: 0,
    })
  })

  it('leaves the built-in fireworks provider with no usable credential', () => {
    // In pi 1.5.0 a `models` entry on a built-in provider is ADDED to that
    // provider's catalog rather than substituted for it, so declaring only the
    // US router under `fireworks` still leaves every global Fireworks model
    // selectable and runnable. The containment that works is a separate
    // provider id plus a built-in `fireworks` block whose apiKey names a
    // variable nothing sets: pi then answers "No API key found for fireworks"
    // and no global-id model can be resolved. Pointing that block at the US
    // host is belt-and-braces, so a future change that does give it a key
    // still cannot reach the global endpoint.
    const config = loadModels()
    const legacy = provider(config, 'fireworks')
    assert.equal(
      legacy.models,
      undefined,
      'the built-in fireworks provider must not declare models; that would make global ids selectable again',
    )
    assert.match(
      legacy.apiKey ?? '',
      /^\$[A-Z][A-Z0-9_]*$/,
      'the built-in fireworks block must resolve its key from an environment variable',
    )
    const referenced = (legacy.apiKey ?? '').slice(1)
    // The name must be one nothing provides. If a real key var were used here,
    // pi would try that many attempts against every global Fireworks model.
    for (const file of [SETUP_SCRIPT, COMPOSE, RENDER_ENV]) {
      assert.ok(
        !new RegExp(`^\\s*${referenced}:`, 'm').test(read(file)),
        `the built-in fireworks provider's key variable ${referenced} is provided by ${path.basename(file)}`,
      )
    }
    assert.ok(
      !read(COMPOSE).includes(`${referenced}:`),
      `${referenced} must not be passed into the container either`,
    )
    assert.equal(
      legacy.baseUrl,
      US_BASE_URL,
      'even the disabled built-in block must not name the global host',
    )
  })

  it('has no environment variable that could satisfy the built-in fireworks provider', () => {
    // The mechanism above is subtle and worth pinning, because the plausible
    // alternative reading ("an unresolved $VAR falls through to the provider's
    // own FIREWORKS_API_KEY") is false but easy to believe: pi 1.5.0's
    // resolveConfigValueOrThrow THROWS when a models.json reference does not
    // resolve, and composeApiKeyAuth resolves rawKey instead of delegating to
    // the provider's inherited auth, so the real key is never consulted.
    //
    // What this test can state without spawning pi is the property that makes
    // that true: the only Fireworks key in the container is FIREWORKS_API_KEY,
    // and the disabled block does not name it. Behaviour was verified out of
    // band by setting FIREWORKS_API_KEY and running a global id, which fails
    // with "No API key found for fireworks" and sends no request.
    const compose = read(COMPOSE)
    const keyNames = [...compose.matchAll(/^\s+(FIREWORKS[A-Z0-9_]*):/gm)].map((m) => m[1])
    assert.deepEqual(
      [...new Set(keyNames)],
      ['FIREWORKS_API_KEY'],
      'the container must receive exactly one Fireworks key variable',
    )
    const legacyKey = provider(loadModels(), 'fireworks').apiKey
    assert.notEqual(
      legacyKey,
      '$FIREWORKS_API_KEY',
      'the disabled built-in provider must not reference the real key; that is the whole containment',
    )
  })

  it('runs every agent on that one model', () => {
    const source = read(RENDER_ENV)
    for (const key of ['LEAD_MODEL_OVERRIDE', 'WORKER_MODEL_OVERRIDE']) {
      const match = source.match(new RegExp(`^${key}=(.+)$`, 'm'))
      assert.ok(match, `render-env.sh does not set ${key}`)
      assert.equal(match[1].trim(), `${PROVIDER_ID}/${US_ROUTER_ID}`)
    }
    // The harness is what reads models.json at all.
    assert.match(source, /^HARNESS_PROVIDER=pi$/m)
  })

  it('passes the key and the agent dir into the worker', () => {
    // compose enumerates env vars, so a key render-env.sh writes into .env and
    // compose does not list never reaches the container.
    const source = read(COMPOSE)
    assert.match(source, /^\s+FIREWORKS_API_KEY: \$\{FIREWORKS_API_KEY\}$/m)
    assert.match(source, /^\s+PI_CODING_AGENT_DIR: \$\{PI_CODING_AGENT_DIR:-\/workspace\/personal\/\.pi\}$/m)
  })

  it('keeps an Anthropic key out of the swarm, so a stray pin fails instead of billing', () => {
    // No agent runs an Anthropic model, and the pi harness is the only thing in
    // a worker that would read the key. Withholding it turns a task that pins
    // an Anthropic model into a failure before its first turn instead of work
    // billed at ~9x the Fireworks price. The old `delegate/` stack owns its own
    // DELEGATES secret and still needs the key there; this is about the swarm.
    const source = read(COMPOSE)
    assert.doesNotMatch(source, /^\s*(-\s*)?ANTHROPIC_API_KEY[:=]/m)
    // render-env.sh requires every key it names, so a stale entry here would
    // stop the host from rendering .env once the secret no longer holds one.
    const renderEnv = read(RENDER_ENV)
    const required = renderEnv.match(/^REQUIRED_KEYS=\(([\s\S]*?)^\)/m)
    assert.ok(required, 'render-env.sh no longer declares REQUIRED_KEYS')
    assert.doesNotMatch(required[1], /ANTHROPIC_API_KEY/)
  })

  it('marks the model as custom when sync-agent-config.sh writes it through the API', () => {
    // agent-swarm's model catalog (models.dev's `fireworks-ai` section) lists no
    // US-only router, and its runtime PATCH answers 400 "Unknown model" for an
    // id the catalog does not know unless the caller vouches for it with
    // `allow_custom_model`. Without this flag sync-agent-config.sh fails on the last
    // step and the agents keep whatever MODEL_OVERRIDE they had before, which
    // is the silent half-failure this test is here to prevent.
    const source = read(SYNC_AGENT_CONFIG)
    assert.match(
      source,
      /PATCH "\/api\/agents\/\$agent\/runtime"/,
      'sync-agent-config.sh no longer PATCHes the agent runtime; re-check how the model is set',
    )
    assert.match(
      source,
      /allow_custom_model: true/,
      'sync-agent-config.sh must send allow_custom_model: true, or the runtime PATCH 400s on the US router id',
    )
  })

  it('writes models.json where the worker can read it', () => {
    // The setup script runs as root before the privilege drop, so $HOME there
    // is root's and a file under it is invisible to the non-root worker. The
    // path is one explicit value, and compose must name the same one.
    const setup = read(SETUP_SCRIPT)
    const match = setup.match(/^PI_AGENT_DIR=(.+)$/m)
    assert.ok(match, 'global-setup-script.sh does not pin PI_AGENT_DIR')
    const dir = match[1].trim()
    assert.equal(
      dir,
      '/workspace/personal/.pi',
      'the pi agent dir must be the single explicit value compose also names',
    )
    assert.ok(
      read(COMPOSE).includes(`PI_CODING_AGENT_DIR: \${PI_CODING_AGENT_DIR:-${dir}}`),
      'docker-compose.yml must default PI_CODING_AGENT_DIR to the same path the setup script writes',
    )
    // Evidence it writes there, owned by the worker.
    assert.ok(
      new RegExp(`mv -f "\\$PI_MODELS_TMP" "\\$PI_AGENT_DIR/models.json"`).test(setup),
      'the setup script must rename models.json into the agent dir',
    )
    assert.match(setup, /^chown worker:worker "\$PI_MODELS_TMP"$/m)
    // The block runs as root against a path on the worker's own volume, so a
    // symlink planted there would let root chown/`install -d` an arbitrary
    // target. It must refuse a non-directory before touching it.
    assert.match(
      setup,
      /if \[ -L "\$PI_AGENT_DIR" \] \|\| \{ \[ -e "\$PI_AGENT_DIR" \] && \[ ! -d "\$PI_AGENT_DIR" \]; \}; then/,
      'the setup script must refuse a symlink or non-directory at the agent dir before writing there as root',
    )
  })

  it('mentions no Fireworks model id that is not a US-only router', () => {
    // The whole directory, not just the three files above: a new script that
    // reintroduces a global id is a regression wherever it lands. The disabled
    // `fireworks` block names no model, so it contributes none.
    for (const file of hostFiles()) {
      const name = path.relative(HOST_DIR, file)
      for (const id of fireworksIds(fs.readFileSync(file, 'utf8'))) {
        assert.match(
          id,
          US_FIREWORKS_ROUTER,
          `${name} mentions "${id}", which is not a US-only router id; use accounts/fireworks/routers/<model>-us`,
        )
      }
    }
  })

  it('names the US host everywhere and the global host nowhere', () => {
    // The failure this catches is the one the ops docs warn about: a base URL
    // that quietly reverts to the global host, which is a global request with
    // no error and no visible difference in the logs.
    let sawUsHost = false
    for (const file of hostFiles()) {
      const name = path.relative(HOST_DIR, file)
      const source = fs.readFileSync(file, 'utf8')
      for (const host of fireworksHosts(source)) {
        assert.equal(
          host,
          US_HOST,
          `${name} names the Fireworks host "${host}"; the swarm must stay on ${US_HOST}`,
        )
      }
      if (source.includes(US_BASE_URL)) sawUsHost = true
    }
    assert.ok(sawUsHost, `no file under host/ names ${US_BASE_URL}`)
  })
})
