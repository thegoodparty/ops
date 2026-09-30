// Hidden check for p2p-phone-list-late-cap. Copied into
// packages/gp-api/src/ at deploy time, run, and removed; the agent never sees
// it.
//
// The symptom: POST /v1/p2p/phone-list for an audience far over the
// 100,000-recipient cap never answers inside the gateway's 120 s, so the
// caller is cut off with no status, and the handler keeps reading voter pages
// for a response nobody is waiting for.
//
// The only thing replaced is the Databricks statement client, the lowest seam
// every voter read passes through. It answers COUNT statements with the
// audience size and page statements with rows, at a latency modelled on the
// warehouse. Everything above it (the district lookup, findPeople, the
// contacts service, audience resolution, the upload service, the controller)
// is the checkout's own code, so a fix that counts first, pages in parallel,
// streams, stops early, or refuses up front all pass, and one that only moves
// the in-loop cap does not.
import { useTestService } from '@/test-service'
import { ElectionsService } from '@/elections/services/elections.service'
import { ElectionApiDistrictService } from '@/peopleDb/services/electionApiDistrict.service'
import {
  PeopleDbxStatementClient,
  PeopleDbxUnavailableError,
} from '@/peopleDb/databricks/peopleDbxStatement.client'
import { PeerlyPhoneListService } from '@/vendors/peerly/services/peerlyPhoneList.service'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficeLevel } from './generated/prisma'

const service = useTestService()

// Wall clock is scaled down so the fault shows in about half a minute rather
// than four. Every duration below is multiplied by it, the gateway deadline
// included, so the race between the handler and the deadline is the one prod
// ran. The audience size, the cap and the page size are real.
const SCALE = 0.25
const GATEWAY_DEADLINE_MS = 120_000 * SCALE

// Measured on the firing request: ~2.17 s per 1,000-row page. Split into a
// fixed cost and a per-row cost, so a fix that asks for bigger pages pays for
// the rows it asks for rather than getting them free.
const pageLatencyMs = (rows: number) => SCALE * (1_000 + 1.17 * rows)
const COUNT_LATENCY_MS = SCALE * 2_000

// Well over the cap: the incident's filters matched districts of this size.
const MATCHED = 150_000

const WIN_SLUG = 'bugboss-eval-p2p'
const ORG_SLUG_HEADER = 'X-Organization-Slug'
const DISTRICT_ID = '20000000-0000-0000-0000-000000000000'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const personValue = (column: string, i: number): string | null => {
  if (column === 'id') {
    return `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
  }
  if (column === 'LALVOTERID') return `LALSYN${i}`
  if (column === 'FirstName') return 'Synthetic'
  if (column === 'LastName') return `Voter${i}`
  if (column === 'VoterTelephones_CellPhoneFormatted') {
    return `555${String(i).padStart(7, '0')}`
  }
  if (column.endsWith('_AddressLine')) return `${i} Main St`
  if (column.endsWith('_City')) return 'Springfield'
  if (column === 'State' || column.endsWith('_State')) return 'CA'
  if (column.endsWith('_Zip')) return '90210'
  if (column === 'Age' || column === 'Age_Int') return '40'
  return null
}

const fakeWarehouse = () => {
  const pageReads: number[] = []
  let closed = false

  const query = async (statement: {
    sql: string
    params: Array<{ name: string; value: string | null }>
  }) => {
    if (closed) throw new PeopleDbxUnavailableError('the check has finished')
    const param = (name: string) =>
      Number(statement.params.find((p) => p.name === name)?.value ?? 0)
    const head = statement.sql.split(' FROM ')[0]
    const paging = statement.sql.match(/LIMIT :(p\d+) OFFSET :(p\d+)\s*$/)

    if (paging) {
      pageReads.push(Date.now())
      const take = param(paging[1])
      const skip = param(paging[2])
      const count = Math.max(0, Math.min(take, MATCHED - skip))
      await sleep(pageLatencyMs(count))
      if (closed) throw new PeopleDbxUnavailableError('the check has finished')
      const columns = [...head.matchAll(/ AS `([^`]+)`/g)].map((m) => m[1])
      const rows = Array.from({ length: count }, (_, k) =>
        columns.map((column) => personValue(column, skip + k)),
      )
      return { columns, rows }
    }

    await sleep(COUNT_LATENCY_MS)
    const aliases = [...head.matchAll(/ AS `?(\w+)`?/g)].map((m) => m[1])
    const columns = aliases.length > 0 ? aliases : ['count']
    return {
      columns,
      rows: [
        columns.map((alias) =>
          alias.toLowerCase().startsWith('avg') ? '40' : String(MATCHED),
        ),
      ],
    }
  }

  return {
    query,
    pageReads,
    close: () => {
      closed = true
    },
  }
}

const seedWinCampaign = async () => {
  await service.prisma.organization.create({
    data: {
      slug: WIN_SLUG,
      ownerId: service.user.id,
      overrideDistrictId: DISTRICT_ID,
    },
  })
  const campaign = await service.prisma.campaign.create({
    data: {
      userId: service.user.id,
      slug: `${WIN_SLUG}-campaign`,
      organizationSlug: WIN_SLUG,
      isPro: true,
    },
  })
  await service.prisma.tcrCompliance.create({
    data: {
      campaignId: campaign.id,
      ein: '12-3456789',
      postalAddress: '1 Synthetic Way',
      committeeName: 'Synthetic Committee',
      websiteDomain: 'example.com',
      filingUrl: 'https://example.com/filing',
      phone: '5550000000',
      email: 'eval@example.com',
      officeLevel: OfficeLevel.state,
      peerlyIdentityId: 'peerly-identity-eval',
    },
  })
}

describe('POST /v1/p2p/phone-list for an audience over the recipient cap', () => {
  let warehouse: ReturnType<typeof fakeWarehouse> | undefined

  afterEach(async () => {
    // Anything still paging after the verdict is ended here, so the handler
    // stops before the app closes underneath it.
    warehouse?.close()
    await sleep(pageLatencyMs(1_000) * 2)
  })

  it(
    'answers the caller before the gateway gives up',
    async () => {
      vi.spyOn(
        service.app.get(ElectionsService),
        'getDistrict',
      ).mockResolvedValue({
        id: DISTRICT_ID,
        state: 'CA',
        L2DistrictType: 'County',
        L2DistrictName: 'Synthetic County',
        projectedTurnout: null,
      } as never)
      vi.spyOn(
        service.app.get(ElectionApiDistrictService),
        'findDistrictById',
      ).mockResolvedValue({
        type: 'County',
        name: 'Synthetic County',
        state: 'CA',
      } as never)
      vi.spyOn(
        service.app.get(PeerlyPhoneListService),
        'uploadPhoneList',
      ).mockResolvedValue('peerly-upload-token')
      warehouse = fakeWarehouse()
      vi.spyOn(
        service.app.get(PeopleDbxStatementClient),
        'query',
      ).mockImplementation(warehouse.query as never)

      await seedWinCampaign()

      const sentAt = Date.now()
      const outcome = await service.client
        .post(
          '/v1/p2p/phone-list',
          { name: 'Everyone in the district' },
          {
            headers: { [ORG_SLUG_HEADER]: WIN_SLUG },
            timeout: GATEWAY_DEADLINE_MS,
          },
        )
        .then(
          (res) => ({ answered: true as const, status: res.status, at: Date.now() }),
          (err: { code?: string }) => {
            if (err.code !== 'ECONNABORTED') throw err
            return { answered: false as const, status: null, at: Date.now() }
          },
        )

      console.log(
        `phone-list: ${outcome.answered ? `answered ${outcome.status}` : 'no answer'} ` +
          `after ${outcome.at - sentAt} ms (deadline ${GATEWAY_DEADLINE_MS} ms), ` +
          `${warehouse.pageReads.length} page reads so far`,
      )

      expect(
        warehouse.pageReads.length,
        'the request never reached the voter warehouse, so the check proves nothing',
      ).toBeGreaterThan(0)

      expect.soft(
        outcome.answered,
        `SYMPTOM: POST /v1/p2p/phone-list gave the caller no answer within the gateway's ` +
          `${GATEWAY_DEADLINE_MS} ms (scaled from 120 s) for an audience of ${MATCHED} ` +
          `against a 100000-recipient cap`,
      ).toBe(true)

      if (!outcome.answered) {
        // Background work after an answer is a legitimate design, so the
        // waste is only measured once the caller has been cut off.
        const graceMs = pageLatencyMs(1_000) * 1.5
        await sleep(pageLatencyMs(1_000) * 6)
        const afterAbandon = warehouse.pageReads.filter(
          (t) => t > outcome.at + graceMs,
        ).length
        expect.soft(
          afterAbandon,
          `SYMPTOM: the handler kept reading voter pages after the caller was cut off ` +
            `(${afterAbandon} more page reads in ${Math.round(pageLatencyMs(1_000) * 4.5)} ms)`,
        ).toBe(0)
      }
    },
    GATEWAY_DEADLINE_MS * 3,
  )
})
