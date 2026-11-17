import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * The swarm's model catalogue overlay, checked against the files a deploy
 * reads.
 *
 * The swarm runs one model, the US-only Fireworks router. agent-swarm's
 * catalogue is models.dev's `fireworks-ai` section, which lists neither a
 * `fireworks-us` provider nor that id, so its console could not see the model
 * at all: the runtime page said "No reasoning effort applies to this model",
 * the effort picker offered nothing, a `reasoning_effort` PATCH was rejected
 * and the context window fell back to 200k instead of 1M. The agents think
 * regardless: pi clamps its default level through this model's
 * `thinkingLevelMap` and sends adaptive thinking at `high` (see the level test
 * below, and `global-setup-script.sh` for the fields).
 *
 * The fix is an overlay row (`PUT /api/models-catalog/overlay`), written by
 * `sync-agent-config.sh` on every deploy. These tests pin the two halves that
 * can silently stop working:
 *
 * 1. the `models.json` heredoc in `global-setup-script.sh` still carries the
 *    thinking fields, and they still resolve to a real effort level, and
 * 2. the row `sync-agent-config.sh` sends is DERIVED from that heredoc rather
 *    than restated beside it, so editing the model's `thinkingLevelMap`
 *    cannot leave a stale effort list behind in the console.
 *
 * Everything here reads local files and runs the shell the deploy runs; no
 * network, no swarm.
 */

const HOST_DIR = path.resolve(__dirname, '..')
const SETUP_SCRIPT = path.join(HOST_DIR, 'global-setup-script.sh')
const SYNC_AGENT_CONFIG = path.join(HOST_DIR, 'sync-agent-config.sh')
const RENDER_ENV = path.join(HOST_DIR, 'render-env.sh')

const US_ROUTER_ID = 'accounts/fireworks/routers/deepseek-v4p1-flash-1017-us'
const PROVIDER_ID = 'fireworks-us'

/** pi's thinking levels, in pi's order (`@earendil-works/pi-ai`'s `EXTENDED_THINKING_LEVELS`). */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The provider effort tokens models.dev uses, i.e. the keys of agent-swarm's
 * `EFFORT_VALUE_MAP` (`packages/model-catalog` in the pinned upstream tag).
 * `off` in the model's `thinkingLevelMap` maps to `none` here: the console's
 * `off` is its own normalized level, and a literal `"off"` in
 * `reasoning_options.values` would be dropped without a word.
 */
const MODELS_DEV_EFFORT_TOKENS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

const read = (file: string): string => fs.readFileSync(file, 'utf8')

/** The `models.json` heredoc out of the setup script, as the worker receives it. */
const modelsJsonSource = (source = read(SETUP_SCRIPT)): string => {
  const match = source.match(/^cat >"\$PI_MODELS_TMP" <<'PI_MODELS_JSON'\n([\s\S]*?)\nPI_MODELS_JSON$/m)
  assert.ok(match, 'global-setup-script.sh has no PI_MODELS_JSON heredoc')
  return match[1]
}

type ThinkingModel = {
  id: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
  compat?: Record<string, boolean>
}

const servedModel = (source = read(SETUP_SCRIPT)): ThinkingModel => {
  const config = JSON.parse(modelsJsonSource(source)) as {
    providers: Record<string, { models?: ThinkingModel[] }>
  }
  const models = config.providers[PROVIDER_ID]?.models ?? []
  const found = models.find((model) => model.id === US_ROUTER_ID)
  assert.ok(found, `models.json does not define ${PROVIDER_ID}/${US_ROUTER_ID}`)
  return found
}

/** The provider effort tokens a `thinkingLevelMap` maps its levels onto, de-duplicated in map order. */
const effortTokens = (map: Record<string, string | null>): string[] => [
  ...new Set(Object.values(map).filter((token): token is string => token !== null)),
]

/**
 * The level pi actually runs with, given the level it asks for by default and
 * `clampThinkingLevel`/`getSupportedThinkingLevels` from `@earendil-works/pi-ai`:
 * a level the map sends to `null` is unavailable, and clamping walks forward
 * through pi's level order before it walks back.
 */
const effectiveThinkingLevel = (map: Record<string, string | null>, requested: string): string => {
  const supported = PI_THINKING_LEVELS.filter((level) => map[level] !== null)
  if (supported.includes(requested)) return requested
  const from = PI_THINKING_LEVELS.indexOf(requested)
  for (let i = from; i < PI_THINKING_LEVELS.length; i += 1) {
    if (supported.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i]
  }
  for (let i = from - 1; i >= 0; i -= 1) {
    if (supported.includes(PI_THINKING_LEVELS[i])) return PI_THINKING_LEVELS[i]
  }
  return 'off'
}

/** The model every agent runs, as `render-env.sh` writes it: `<provider>/<id>`. */
const deployedModel = (): string => {
  const match = read(RENDER_ENV).match(/^LEAD_MODEL_OVERRIDE=(.+)$/m)
  assert.ok(match, 'render-env.sh does not set LEAD_MODEL_OVERRIDE')
  return match[1].trim()
}

/**
 * The body of a `name() { ... }` shell function, closing brace included. The
 * deploy runs this text, so a test that runs it too cannot pass on a function
 * the deploy no longer has.
 */
const shellFunction = (source: string, name: string): string => {
  const start = source.indexOf(`${name}() {`)
  assert.ok(start >= 0, `sync-agent-config.sh no longer defines ${name}()`)
  const end = source.indexOf('\n}\n', start)
  assert.ok(end >= 0, `${name}() is not closed by a bare } on its own line`)
  return source.slice(start, end + 3)
}

/**
 * The block that builds the row and PUTs it. Extracted rather than described so
 * the test exercises the real control flow, including what happens when the
 * write fails.
 */
const overlayBlock = (source: string): string => {
  const start = source.indexOf('# The heredoc body out of')
  assert.ok(start >= 0, 'sync-agent-config.sh no longer reads the models.json heredoc')
  const end = source.indexOf('\nfi\n', start)
  assert.ok(end >= 0, 'the overlay block is not closed by a bare fi on its own line')
  return source.slice(start, end + 4)
}

const hasTool = (tool: string): boolean =>
  spawnSync('bash', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0

const missingTools = ['bash', 'awk', 'jq'].filter((tool) => !hasTool(tool))
const skip = missingTools.length ? `needs ${missingTools.join(', ')} on PATH` : false

const SETUP_SCRIPT_EXIT = 0

type OverlayRun = {
  status: number | null
  stdout: string
  stderr: string
  /** The JSON body the call sent, parsed. Absent when nothing was sent. */
  body?: Record<string, unknown>
  /** The body exactly as it went on the wire, for the idempotency check. */
  raw?: string
}

/**
 * Runs the deploy's overlay block against a copy of the setup script, with
 * `api` stubbed to record the body instead of reaching the swarm. `setup`
 * replaces `global-setup-script.sh` for the mutation test.
 */
const runOverlay = (opts: { setup?: string; apiFails?: boolean } = {}): OverlayRun => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-overlay-'))
  try {
    const setup = path.join(dir, 'global-setup-script.sh')
    fs.writeFileSync(setup, opts.setup ?? read(SETUP_SCRIPT))
    const bodyFile = path.join(dir, 'body.json')
    const harness = path.join(dir, 'harness.sh')
    fs.writeFileSync(
      harness,
      [
        'set -euo pipefail',
        // The same value render-env.sh writes, so a hard-coded id in the script
        // would not satisfy the assertion below.
        `LEAD_MODEL=${deployedModel()}`,
        'api() {',
        `  cat >${JSON.stringify(bodyFile)}`,
        `  return ${opts.apiFails ? 22 : 0}`,
        '}',
        shellFunction(read(SYNC_AGENT_CONFIG), 'model_catalog_overlay_body'),
        overlayBlock(read(SYNC_AGENT_CONFIG)),
      ].join('\n'),
      { mode: 0o755 },
    )
    const result = spawnSync('bash', [harness], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', TMPDIR: dir },
    })
    const raw = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : undefined
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      raw,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('agent-swarm model reasoning facts', () => {
  it('marks the served model as reasoning, with a thinkingLevelMap on pi`s levels', () => {
    // fireworks-residency.test.ts pins `reasoning: true` for the residency
    // rule; what matters here is that the rest of the thinking configuration is
    // still there, because pi reads all of it and the console mirrors it.
    const model = servedModel()
    assert.equal(model.reasoning, true, 'the served model must still be a reasoning model')
    const map = model.thinkingLevelMap
    assert.ok(map, 'models.json must carry a thinkingLevelMap for the served model')
    assert.deepEqual(
      Object.keys(map).sort(),
      [...PI_THINKING_LEVELS].sort(),
      'thinkingLevelMap must name exactly pi`s thinking levels, or pi cannot map the one it resolves',
    )
  })

  it('maps every level onto a provider effort token the console understands', () => {
    // models.dev semantics: these values go to the provider as its own effort
    // vocabulary, and agent-swarm's EFFORT_VALUE_MAP maps only these tokens
    // (`none` → its normalized `off`). A literal `off`, or any other word,
    // would be dropped from the console's level list silently, leaving the
    // picker with fewer levels than the model has.
    const map = servedModel().thinkingLevelMap!
    for (const [level, token] of Object.entries(map)) {
      if (token === null) continue
      assert.ok(
        MODELS_DEV_EFFORT_TOKENS.includes(token),
        `${level} maps to "${token}", which is not a models.dev effort token; ` +
          `use one of ${MODELS_DEV_EFFORT_TOKENS.join('/')}`,
      )
    }
    assert.ok(
      Object.values(map).includes(null),
      'at least one level must be unmapped: this model does not take every level',
    )
    assert.ok(effortTokens(map).length >= 2, 'the model must accept more than one effort level')
  })

  it('resolves a real thinking level from pi`s default, not "off"', () => {
    // This is why the symptom was the console's and not the agent's: pi sends
    // no thinkingLevel option here, agent-swarm passes none, so pi falls back
    // to its own default (medium). This model maps medium to null, and
    // clampThinkingLevel walks forward to the next supported level.
    const map = servedModel().thinkingLevelMap!
    const effective = effectiveThinkingLevel(map, 'medium')
    assert.notEqual(effective, 'off', 'the swarm must never run this model with thinking off')
    assert.equal(effective, 'high', 'the default session level for this model is high')
    assert.equal(map[effective], 'high', 'and it travels as the provider token "high"')
  })

  it('runs adaptive thinking, which is what the anthropic-messages transport needs', () => {
    // `compat.forceAdaptiveThinking` is what makes pi send
    // `thinking: {type:"adaptive"}` with the effort alongside it, instead of an
    // anthropic `budget_tokens` block the Fireworks router does not accept.
    const compat = servedModel().compat
    assert.ok(compat, 'models.json must carry a compat block for the served model')
    assert.equal(compat.forceAdaptiveThinking, true)
    assert.equal(compat.allowEmptySignature, true)
  })
})

describe('agent-swarm model catalogue overlay', () => {
  it('sends a row for the model the agents actually run', { skip }, () => {
    const run = runOverlay()
    assert.equal(run.status, SETUP_SCRIPT_EXIT, run.stderr)
    const [provider, ...rest] = deployedModel().split('/')
    assert.equal(run.body?.provider, provider)
    assert.equal(run.body?.modelId, rest.join('/'))
    assert.equal(run.body?.modelId, US_ROUTER_ID)
  })

  it('carries reasoning facts derived from the models.json heredoc', { skip }, () => {
    const run = runOverlay()
    assert.equal(run.status, SETUP_SCRIPT_EXIT, run.stderr)
    const model = servedModel()
    const options = run.body?.reasoningOptions as { type: string; values?: string[] }[]
    assert.ok(Array.isArray(options), 'the row must carry reasoningOptions')
    assert.equal(options.length, 1)
    assert.equal(options[0].type, 'effort', 'the console reads only `type: "effort"` values')
    // Exactly the heredoc`s own tokens, in its order: the map`s non-null values.
    assert.deepEqual(options[0].values, effortTokens(model.thinkingLevelMap!))
    assert.equal(run.body?.reasoning, true)
  })

  it('gives the console the real context window and output limit', { skip }, () => {
    // Without the row agent-swarm falls back to a 200k window and no output
    // limit, so a session looks nearly full at a fifth of the model.
    const run = runOverlay()
    const model = servedModel()
    assert.equal(run.body?.contextWindow, model.contextWindow)
    assert.equal(run.body?.contextWindow, 1000000)
    assert.equal(run.body?.maxOutput, model.maxTokens)
    assert.equal(run.body?.maxOutput, 384000)
  })

  it('follows the heredoc when the model`s levels change', { skip }, () => {
    // The anti-drift test the whole design is for: edit the model`s
    // thinkingLevelMap, and the row the deploy sends changes with it. A second
    // hand-written level list in the script would keep sending the old one.
    const setup = read(SETUP_SCRIPT)
    const mutated = setup.replace('"medium": null', '"medium": "medium"')
    assert.notEqual(mutated, setup, 'the heredoc no longer maps medium to null; update this test')
    const run = runOverlay({ setup: mutated })
    assert.equal(run.status, SETUP_SCRIPT_EXIT, run.stderr)
    const options = run.body?.reasoningOptions as { values?: string[] }[]
    assert.deepEqual(options[0].values, effortTokens(servedModel(mutated).thinkingLevelMap!))
    assert.ok(
      options[0].values?.includes('medium'),
      'a level the heredoc gains must reach the console',
    )
  })

  it('states no effort tokens of its own', () => {
    // The derivation above is only worth having if nothing beside it restates
    // the list. `none`, `low`, `high` and `max` may appear as prose, but a
    // quoted list of them would be the copy this test exists to prevent.
    const source = read(SYNC_AGENT_CONFIG)
    assert.ok(
      source.includes('thinkingLevelMap'),
      'the overlay row must read the level list out of models.json',
    )
    assert.ok(
      !/\[\s*"(none|low|high|max)"\s*,/.test(source),
      'sync-agent-config.sh must not restate the model`s effort tokens as a list',
    )
  })

  it('expires never, because models.dev will never list this model', { skip }, () => {
    // `expiresWhenUpstreamMatches` deletes the row once an upstream catalog
    // row for the same provider/id matches every fact. models.dev has no
    // `fireworks-us` section at all, so the condition is unreachable; leaving
    // it at the endpoint's default would label a permanent row as temporary.
    const run = runOverlay()
    assert.equal(run.body?.expiresWhenUpstreamMatches, false)
    assert.ok(
      run.body?.reason,
      'the endpoint requires a reason, and it is what a reviewer reads in the overlay table',
    )
  })

  it('carries the US-only price, derived from the heredoc`s cost block', { skip }, () => {
    // agent-swarm reads an overlay row's `pricing` in `toCatalogModel`, which
    // copies it into the served catalogue's `cost`, so the runtime page and the
    // model picker print the real per-1M rates for the one model the swarm runs.
    // Deriving them from the heredoc keeps them at the US 1.5x rate
    // (docs/bifrost-gateway.md, "The Fireworks premium") instead of a second
    // hand-kept copy that could drift back to the global price.
    const run = runOverlay()
    assert.equal(run.status, SETUP_SCRIPT_EXIT, run.stderr)
    const source = JSON.parse(modelsJsonSource()) as {
      providers: Record<string, { models: { cost?: Record<string, number> }[] }>
    }
    const heredocCost = source.providers[PROVIDER_ID]?.models[0]?.cost
    assert.ok(heredocCost, 'models.json must keep a cost block; this row derives from it')
    assert.deepEqual(run.body?.pricing, {
      input: heredocCost.input,
      output: heredocCost.output,
      cache_read: heredocCost.cacheRead,
      cache_write: heredocCost.cacheWrite,
    })
    // pi's `cacheRead`/`cacheWrite` are camelCase; models.dev's overlay field is
    // snake_case. A camelCase key here would pass validation as an unknown field
    // and silently leave the console with no cache rate.
    const pricing = run.body?.pricing as Record<string, number>
    for (const key of Object.keys(pricing)) {
      assert.ok(
        ['input', 'output', 'cache_read', 'cache_write'].includes(key),
        `${key} is not an overlay pricing field`,
      )
    }
    assert.equal(pricing.input, 0.45)
    assert.equal(pricing.output, 1.8)
  })

  it('records, beside the price, that it cannot change accounting', () => {
    // The honest half, and the reason the README calls the price display-only.
    // `applyOverlayPricingRows` feeds overlay prices to `buildModelsDevSeedRows`,
    // which enumerates a fixed set of provider sections and has no
    // `fireworks-us` case, so this row contributes no `pricing` table rows and a
    // pi session of this model still lands at `costSource: 'unpriced'`. That is
    // an upstream property this repo cannot test; what it CAN pin is that the
    // script keeps saying so next to the field, naming the code path that drops
    // it, so nobody reads `pricing: {...}` as "the swarm now prices this".
    const source = read(SYNC_AGENT_CONFIG)
    assert.ok(source.includes("pricing:"), 'the overlay row must keep its price')
    assert.match(
      source,
      /buildModelsDevSeedRows/,
      'the script must name the projection that drops a fireworks-us price',
    )
    assert.match(
      source,
      /costSource: 'unpriced'|costSource: "unpriced"/,
      'the script must say a session stays unpriced',
    )
    assert.match(source, /display only/i)
  })

  it('is an upsert that can be repeated unchanged', { skip }, () => {
    // The script runs on every deploy. PUT is keyed on (provider, modelId), so
    // repeating it updates one row instead of adding another, and the body must
    // not carry a timestamp or anything else that would differ run to run.
    const first = runOverlay()
    const second = runOverlay()
    assert.equal(first.raw, second.raw)
    assert.equal(SETUP_SCRIPT_EXIT, first.status)
    assert.match(read(SYNC_AGENT_CONFIG), /api PUT \/api\/models-catalog\/overlay/)
  })

  it('reports a failed write and leaves the rest of the sync running', { skip }, () => {
    // A catalogue row is not what makes the agents run, so this cannot be the
    // step that takes a deploy down the way an empty .env value can. The
    // failure still has to be loud: silence is how this went unnoticed.
    const run = runOverlay({ apiFails: true })
    assert.equal(run.status, 0, 'a failed overlay write must not fail the sync')
    assert.match(run.stderr, /model catalogue overlay: the upsert failed/)
    assert.match(run.stderr, /the agents still run/)
    assert.match(run.stderr, /Re-run this script to retry/)
  })

  it('says so when the heredoc is gone, instead of sending nothing quietly', { skip }, () => {
    const run = runOverlay({ setup: read(SETUP_SCRIPT).replace(/<<'PI_MODELS_JSON'/, "<<'GONE'") })
    assert.equal(run.status, 0)
    assert.equal(run.body, undefined, 'nothing may be sent without a model to describe')
    assert.match(run.stderr, /model catalogue overlay:/)
  })
})
