// Hidden check for the ecanvasser-sync-timeout scenario. Copied into
// packages/gp-api/src/ at deploy time and removed afterwards.
//
// The symptom is the one the alert counts: POST /v1/ecanvasser/:id/sync does
// not answer before the gateway's ~120s idle timeout, so the caller gets no
// status at all. This asserts only that: a sync of a campaign with a large
// door-knocking backlog, against a slow voter lookup, answers inside 120s
// without a 5xx. It does not care how. Bounding attribution, batching the
// lookups, caching them, or moving attribution off the request all pass.
//
// The stubs sit at the two outer edges of the request, below anything an
// incident fix would plausibly touch: the eCanvasser vendor client's three
// bulk fetches, and the Databricks statement client every voter read goes
// through. Every statement takes 850ms (the latency measured in production for
// one phone lookup) and matches nobody, which is also what production saw.
import axios from 'axios'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTestService } from './test-service'
import { EcanvasserService } from './vendors/ecanvasserIntegration/services/ecanvasser.service'
import { PeopleDbxStatementClient } from './peopleDb/databricks/peopleDbxStatement.client'
import { ElectionApiDistrictService } from './peopleDb/services/electionApiDistrict.service'

const GATEWAY_IDLE_TIMEOUT_MS = 120_000
const LOOKUP_LATENCY_MS = 850
const INTERACTIONS = 500

const service = useTestService()

let released = false
let statements = 0

// Registered after useTestService, so it runs before the harness closes the
// app. On the unfixed code the request is still walking its backlog when the
// test gives up; failing every later lookup lets it unwind in seconds rather
// than holding app.close() for the remaining seven minutes.
afterAll(() => {
  released = true
})

const contacts = Array.from({ length: INTERACTIONS }, (_, i) => ({
  id: 10_000 + i,
  first_name: `First${i}`,
  last_name: `Last${i}`,
  type: 'Voter',
  volunteer: false,
  deceased: false,
  donor: false,
  contact_details: { mobile: `+1555${String(1_000_000 + i).slice(1)}` },
  created_by: 1,
}))

const interactions = Array.from({ length: INTERACTIONS }, (_, i) => ({
  id: 50_000 + i,
  type: 'Door Knock',
  status: { name: 'Active' },
  rating: 3,
  contact_id: 10_000 + i,
  created_by: 1,
  created_at: new Date(Date.UTC(2026, 0, 1, 12, 0, i % 60)).toISOString(),
}))

describe('POST /v1/ecanvasser/:id/sync on a large door-knocking backlog', () => {
  let campaignId: number

  beforeEach(async () => {
    const slug = `ecanvasser-check-${Date.now()}`
    await service.prisma.organization.create({
      data: {
        slug,
        ownerId: service.user.id,
        overrideDistrictId: 'district-check-1',
      },
    })
    const campaign = await service.prisma.campaign.create({
      data: {
        slug,
        organizationSlug: slug,
        userId: service.user.id,
        isPro: true,
      },
    })
    campaignId = campaign.id
    await service.prisma.ecanvasser.create({
      data: { campaignId, apiKey: 'check-api-key' },
    })

    vi.spyOn(EcanvasserService.prototype, 'fetchContacts').mockResolvedValue(
      contacts as never,
    )
    vi.spyOn(EcanvasserService.prototype, 'fetchHouses').mockResolvedValue([])
    vi.spyOn(
      EcanvasserService.prototype,
      'fetchInteractions',
    ).mockResolvedValue(interactions as never)
    vi.spyOn(
      ElectionApiDistrictService.prototype,
      'findDistrictById',
    ).mockImplementation(async (id: string) => ({
      id,
      type: 'City_Council',
      name: 'District 1',
      state: 'IL',
    }))
    vi.spyOn(PeopleDbxStatementClient.prototype, 'query').mockImplementation(
      async () => {
        if (released) throw new Error('check finished')
        statements++
        await new Promise((resolve) => setTimeout(resolve, LOOKUP_LATENCY_MS))
        return { columns: [], rows: [] }
      },
    )
  })

  it(
    'answers inside the gateway idle timeout',
    async () => {
      const startedAt = Date.now()
      let status: number | null = null
      try {
        const res = await service.client.post(
          `/v1/ecanvasser/${campaignId}/sync`,
          { force: true },
          { timeout: GATEWAY_IDLE_TIMEOUT_MS },
        )
        status = res.status
      } catch (error) {
        if (!axios.isAxiosError(error) || error.code !== 'ECONNABORTED') {
          throw error
        }
      }
      const elapsedMs = Date.now() - startedAt
      console.log(
        `sync answered ${status ?? 'nothing'} after ${elapsedMs}ms, ` +
          `${statements} voter statements run`,
      )

      expect(
        status,
        `SYMPTOM: POST /v1/ecanvasser/:id/sync gave no answer within the gateway's ${GATEWAY_IDLE_TIMEOUT_MS}ms idle timeout (${statements} voter statements run at ${LOOKUP_LATENCY_MS}ms each)`,
      ).not.toBeNull()
      expect(
        status! < 500,
        `SYMPTOM: POST /v1/ecanvasser/:id/sync answered ${status}`,
      ).toBe(true)

      // Not the symptom: proof the check exercised a real sync, so a pass
      // cannot come from the vendor stubs never being reached.
      const stored = await service.prisma.ecanvasserInteraction.count({
        where: { ecanvasser: { campaignId } },
      })
      expect(stored).toBe(INTERACTIONS)
    },
    GATEWAY_IDLE_TIMEOUT_MS + 30_000,
  )
})
