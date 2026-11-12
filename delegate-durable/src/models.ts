import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'

const fileCredentials = (path: string): CredentialStore => {
  let chain = Promise.resolve()
  const load = async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, Credential>
  const save = async (all: Record<string, Credential>) => {
    await writeFile(`${path}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 })
    await chmod(`${path}.tmp`, 0o600)
    await rename(`${path}.tmp`, path)
  }
  const serial = <T>(work: () => Promise<T>) => {
    const result = chain.then(work)
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  return {
    read: async (providerId) => (await load())[providerId],
    list: async () => Object.entries(await load()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: (providerId, fn) =>
      serial(async () => {
        const all = await load()
        const next = await fn(all[providerId])
        if (next === undefined) return all[providerId]
        await save({ ...all, [providerId]: next })
        return next
      }),
    delete: (providerId) =>
      serial(async () => {
        const { [providerId]: _removed, ...rest } = await load()
        await save(rest)
      }),
  }
}

export const createDelegateModels = () => {
  const authFile = process.env.DELEGATE_AUTH_FILE
  return builtinModels(authFile === undefined || authFile === '' ? {} : { credentials: fileCredentials(authFile) })
}
