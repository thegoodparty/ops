import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openDelegate } from './delegate.ts'
import { createDelegateModels } from './models.ts'

const content = process.argv.slice(2).join(' ').trim()
if (content === '') {
  console.error('usage: npm run cli -- "message"')
  process.exit(2)
}

const delegate = await openDelegate({
  dataDir: process.env.DELEGATE_DATA ?? join(process.cwd(), '.data'),
  omniRepo: process.env.OMNI_REPO,
  models: createDelegateModels(),
  model: {
    provider: process.env.DELEGATE_MODEL_PROVIDER ?? 'anthropic',
    modelId: process.env.DELEGATE_MODEL_ID ?? 'claude-sonnet-5-5',
  },
  persona: await readFile(join(import.meta.dirname, '..', 'prompts', 'delegate.md'), 'utf8'),
  postSlack: async ({ channel, threadTs, text }) => {
    console.log(`[slack ${channel}${threadTs === undefined ? '' : ` ${threadTs}`}] ${text}`)
    return {}
  },
  postGithub: async ({ repo, number, text }) => console.log(`[github ${repo}#${number}] ${text}`),
  onReport: (report) => console.error(`report ${report.kind}`, report.error),
})

try {
  const submission = await delegate.submit('cli:local', { content, requestId: `cli:${Date.now()}` })
  const settled = await submission!.wait(BACKGROUND_CONTEXT)
  if (settled.status === 'done' && settled.type === 'input') console.log(await delegate.answer(settled.answer))
  else console.error(`unanswered: ${settled.status === 'unanswered' ? settled.reason : settled.status}`)
  console.error(`cost so far: $${(await delegate.status()).cost.total.toFixed(4)}`)
} finally {
  await delegate.close()
}
