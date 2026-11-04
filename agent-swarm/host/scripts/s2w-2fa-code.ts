import type { ScriptContext } from 'swarm-sdk'
import * as z from 'zod'

const STEP_MS = 30_000
const MIN_REMAINING_MS = 5_000
const DIGITS = 6
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const argsSchema = z.object({})

// Error messages here never include the seed, so they are safe to surface.
export const base32Decode = (seed: string): Uint8Array => {
  const clean = seed.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (clean.length === 0) throw new Error('seed invalid')
  const bytes: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of clean) {
    const v = BASE32.indexOf(ch)
    if (v < 0) throw new Error('seed invalid')
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
      acc &= (1 << bits) - 1
    }
  }
  if (bytes.length === 0) throw new Error('seed invalid')
  return new Uint8Array(bytes)
}

export const hotp = async (
  key: Uint8Array,
  counter: number,
  digits: number = DIGITS,
): Promise<string> => {
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter))
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, msg))
  const offset = mac[mac.length - 1] & 0x0f
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const totp = (
  key: Uint8Array,
  timeMs: number,
  digits: number = DIGITS,
): Promise<string> => hotp(key, Math.floor(timeMs / STEP_MS), digits)

type Clock = {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms)),
}

// A code with under 5s left can expire before the agent submits it, so wait
// for the next step. The extra 100ms keeps an early timer from landing on the
// old step.
export const generateCode = async (
  seed: string,
  clock: Clock = realClock,
): Promise<string> => {
  const key = base32Decode(seed)
  const remaining = STEP_MS - (clock.now() % STEP_MS)
  if (remaining < MIN_REMAINING_MS) await clock.sleep(remaining + 100)
  return totp(key, clock.now())
}

export default async function (
  _args: z.infer<typeof argsSchema>,
  ctx: ScriptContext,
) {
  const raw = ctx.swarm.config.get('S2W_TOTP_SEED')
  if (raw === undefined) throw new Error('seed missing')
  const code = await generateCode(ctx.stdlib.Redacted.value(raw))
  return { code }
}
