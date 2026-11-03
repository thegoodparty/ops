import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { base32Decode, generateCode, totp } from './s2w-2fa-code'

// RFC 6238 Appendix B published SHA-1 test secret, "12345678901234567890".
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

// Appendix B SHA-1 8-digit codes, truncated here to their last 6 digits.
const VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
]

describe('base32Decode', () => {
  it('decodes the RFC seed to its ASCII bytes', () => {
    assert.equal(
      Buffer.from(base32Decode(RFC_SEED)).toString('ascii'),
      '12345678901234567890',
    )
  })

  it('accepts lowercase, spaces and padding', () => {
    const spaced = RFC_SEED.toLowerCase().replace(/(.{4})/g, '$1 ') + '===='
    assert.deepEqual(base32Decode(spaced), base32Decode(RFC_SEED))
  })

  it('rejects bad input without echoing it', () => {
    for (const bad of ['', '   ', 'not*base32!', '1890']) {
      assert.throws(() => base32Decode(bad), { message: 'seed invalid' })
    }
  })
})

describe('totp', () => {
  for (const [seconds, code] of VECTORS) {
    it(`matches RFC 6238 at T=${seconds}`, async () => {
      assert.equal(await totp(base32Decode(RFC_SEED), seconds * 1000), code)
    })
  }
})

describe('generateCode', () => {
  const clockAt = (startMs: number) => {
    let t = startMs
    const sleeps: number[] = []
    return {
      sleeps,
      clock: {
        now: () => t,
        sleep: async (ms: number) => {
          sleeps.push(ms)
          t += ms
        },
      },
    }
  }

  it('returns the current code without waiting when 5s or more remain', async () => {
    const { clock, sleeps } = clockAt(1111111080 * 1000 + 25_000)
    assert.equal(
      await generateCode(RFC_SEED, clock),
      await totp(base32Decode(RFC_SEED), clock.now()),
    )
    assert.deepEqual(sleeps, [])
  })

  it('waits and returns the next step code at 26s into a step', async () => {
    const stepStart = 1111111080 * 1000
    const { clock, sleeps } = clockAt(stepStart + 26_000)
    const code = await generateCode(RFC_SEED, clock)
    assert.equal(sleeps.length, 1)
    assert.ok(sleeps[0] >= 4_000 && sleeps[0] <= 4_200)
    assert.equal(code, await totp(base32Decode(RFC_SEED), stepStart + 30_000))
    assert.notEqual(code, await totp(base32Decode(RFC_SEED), stepStart))
  })

  it('does not leak the seed in an error', async () => {
    const seed = 'not*base32!secret'
    await assert.rejects(generateCode(seed), (e: Error) => {
      assert.equal(e.message, 'seed invalid')
      assert.ok(!e.message.includes('secret'))
      return true
    })
  })
})
