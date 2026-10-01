import { describe, expect, it } from 'vitest'
import { buildAlertDescription } from '../deploy/components/alerting/alert-notification'
import { Alert } from '../deploy/components/alerting/alerts.types'
import { GLOBAL_ALERTS } from '../deploy/components/alerts'

// Hidden check for the merge-behind scenario. It tests the symptom the pages
// carried: a rule that could not evaluate fires (execErrState is Alerting),
// and its page is written from the rule's own message, so a reader is told
// memory is over 90% and to consider a restart while nothing was measured.
// It reads the page body every rule is provisioned with and asks only that it
// tell the reader a failed evaluation measured nothing. Where the words come
// from (one line for every rule, each message, a shared builder) is the fix's
// business.

const SAYS_NOTHING_WAS_MEASURED =
  /evaluat|nothing (above |here |on this page )?(was |is )?measured|not (been )?measured|state reason|quer(y|ies) (failed|errored|could not run|did not run)/i

// The three rules that paged together in incident 87.
const PAGED = [
  'high-memory',
  'health-check-probe-failure',
  'people-person-id-repoint-collision',
]

const unowned: Alert = {
  slug: 'bugboss-eval-unowned',
  name: 'Synthetic threshold',
  type: 'metric',
  expr: 'vector(0)',
  for: '1m',
  threshold: 1,
  message: 'A synthetic value crossed its threshold.',
}

describe('a page from a rule that could not evaluate', () => {
  it.each(PAGED)('the %s page says a failed evaluation measured nothing', (slug) => {
    const alert = GLOBAL_ALERTS.find((a) => a.slug === slug)
    expect(alert, `no global alert ${slug}`).toBeDefined()
    expect(
      buildAlertDescription(alert!, 'prod'),
      `SYMPTOM: the ${slug} page reads as a breach even when the rule could not evaluate`,
    ).toMatch(SAYS_NOTHING_WAS_MEASURED)
  })

  it('a rule nobody owns says it too', () => {
    expect(
      buildAlertDescription(unowned, 'prod'),
      'SYMPTOM: an unowned rule reads as a breach even when it could not evaluate',
    ).toMatch(SAYS_NOTHING_WAS_MEASURED)
  })
})
