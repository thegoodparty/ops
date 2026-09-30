import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_PROVIDER_TOKEN } from './authentication/interfaces/auth-provider.interface'
import { useTestService } from './test-service'

// Hidden check for the users-read-invalid-zip scenario. It tests the symptom
// the admin console saw: a list or search of users answers 500 when any user
// on the page has a stored zip the signup form would have refused. It seeds
// rows straight into the table, because the column accepts them and that is
// how the real rows got there, and it says nothing about how a fix works:
// relaxing the read schema, normalising on read, or sanitising the output all
// pass. What must not happen is the page failing, or the stored users
// vanishing from it.

const service = useTestService()

const M2M = 'mt_bugboss_eval_check'

const STORED_ZIPS = [
  'ABCDE',
  '123',
  '1234',
  ' 90210 ',
  '90210 1234',
  '902101234',
  '9021-01234',
  'N/A',
]

const SEARCH_NAME = 'Zipcheck'

const seed = async () => {
  const good = [
    { email: 'eval-good-1@example.test', zip: '90210' },
    { email: 'eval-good-2@example.test', zip: '60614-1234' },
    { email: 'eval-good-3@example.test', zip: null },
  ]
  const bad = STORED_ZIPS.map((zip, i) => ({
    email: `eval-bad-${i}@example.test`,
    zip,
  }))
  await service.prisma.user.createMany({
    data: [...good, ...bad].map((u, i) => ({
      email: u.email,
      zip: u.zip,
      firstName: i % 2 === 0 ? SEARCH_NAME : 'Other',
      lastName: 'Eval',
    })),
  })
  return [...good, ...bad].map((u) => u.email)
}

const asAdminConsole = { headers: { Authorization: `Bearer ${M2M}` } }

describe('admin user list with stored zips a signup form would refuse', () => {
  beforeEach(() => {
    // The admin console reaches GET /v1/users with a Clerk M2M token, which
    // the test harness cannot mint. Only the token check is replaced; the
    // guard and everything behind it are the real ones.
    const auth = service.app.get(AUTH_PROVIDER_TOKEN)
    vi.spyOn(auth, 'isM2MToken').mockImplementation((t: string) =>
      t.startsWith('mt_'),
    )
    vi.spyOn(auth, 'verifyM2MToken').mockResolvedValue({
      id: 'mt_eval',
      subject: 'mch_eval_admin_console',
    })
  })

  it('lists a page containing them', async () => {
    const emails = await seed()

    const res = await service.client.get(
      '/v1/users?limit=50&offset=0',
      asAdminConsole,
    )

    expect(res.status, `SYMPTOM: GET /v1/users answered ${res.status}`).toBe(
      200,
    )
    const returned = (res.data.data as Array<{ email: string }>).map(
      (u) => u.email,
    )
    for (const email of emails) {
      expect(
        returned,
        `SYMPTOM: stored user ${email} is missing from the list`,
      ).toContain(email)
    }
  })

  it('answers a name search that matches them', async () => {
    const emails = await seed()

    const res = await service.client.get(
      `/v1/users?limit=20&offset=0&firstName=${SEARCH_NAME}`,
      asAdminConsole,
    )

    expect(
      res.status,
      `SYMPTOM: GET /v1/users?firstName= answered ${res.status}`,
    ).toBe(200)
    const returned = (res.data.data as Array<{ email: string }>).map(
      (u) => u.email,
    )
    const expected = emails.filter((_, i) => i % 2 === 0)
    for (const email of expected) {
      expect(
        returned,
        `SYMPTOM: matching user ${email} is missing from the search`,
      ).toContain(email)
    }
  })
})
