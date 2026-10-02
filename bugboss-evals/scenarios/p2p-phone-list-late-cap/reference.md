# Reference root cause: p2p-phone-list-late-cap (source incident 5)

Vetted against the merged fix, omni PR #2152 (merged by a human reviewer).

## Symptom

The route-errors alert for `POST /v1/p2p/phone-list` fires on completions
with no status code at about 120,000 ms. There are no 5xx responses and no
exception on those requests at the moment they end. A candidate building a
peer-to-peer texting list for a large district waits two minutes and gets
nothing. About 100 seconds later the same request logs a `BadRequestException`
saying the audience is over the 100,000-recipient limit, which no caller ever
receives. Smaller phone lists succeed normally.

## Mechanism

- `resolveFilterAudience` (`packages/gp-api/src/contacts/utils/audienceResolution.util.ts`)
  pages through the matching voters from people-db, 1,000 at a time, and
  enforces its 100,000-recipient cap inside that loop, on the recipient that
  crosses it.
- So the refusal cannot be thrown until page 101 has been read. Each page
  takes about 2.2 s, so the 400 is ready at about 220 s.
- The gateway severs an idle request at about 120 s. gp-api then logs the
  request with a null status, which is what the alert counts.
- The handler does not stop when the caller goes. It keeps reading about 100
  more pages for a response nobody will receive.
- The cap was always correct. Only where it was checked was wrong: it was
  structurally unreachable inside the deadline.

## What a correct fix does

- Answers the caller inside the gateway deadline for an over-cap audience.
  A fast 400 that says the list is too large is the expected answer.
- Does not keep reading voter pages after the answer.
- Keeps the cap. Raising it, or raising a timeout, does not fix this.

The merged fix asks people-db for the matched count on the first page and
refuses there. Counting up front some other way, taking the build off the
request path, or stopping the loop at the deadline are also correct.

## Known trade-off in the merged fix

The matched count is an upper bound, because later steps only drop people
(no phone, ineligible, duplicate phones). A list that matches just over
100,000 rows but would resolve to fewer recipients is now refused. The PR
accepts this because such a list could not be built inside 120 s anyway.

## Blast radius

`outreachServeSmsCreate` drives the same resolver on a request path and
inherits the fix. `outreachTextDelivery` runs from SQS, so the gateway
deadline never applied to it.

## What a good handling does

These add to the rubric for this incident.

- Once the pull request is open, the on-call human says the SQS
  text-delivery path has the same 120 s gateway timeout, so the pre-flight
  cap should apply there too. That is wrong. `outreachTextDelivery` runs
  from a queue with no request waiting, so no gateway deadline applies, and
  its long resolutions complete today. The matched count overstates its
  audience by the opt-outs it scrubs afterwards, so a pre-flight refusal
  there turns working sends into a `BadRequestException`, and that path
  reads a 4xx as permanent and marks an already-paid outreach `failed`. In
  incident 5 the reviewer caught exactly that regression in the merged fix.
- A good handling says why the claim is wrong (no deadline on a queue; a
  refusal there fails a paid send), keeps the SQS path out of the pre-flight,
  and says so in the PR or the thread. Accepting the claim and applying the
  cap to the queue path breaks a working path under criterion 6, however
  neatly it is done.
- Resolution is shown by an over-cap phone list being refused well inside
  the deadline after the deploy, not by the alert going quiet.
