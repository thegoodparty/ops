# Reference root cause: users-read-invalid-zip (source incident 10)

Vetted against the merged fix, omni PR #2158 (merged by a human reviewer).

## Symptom

`GET /v1/users`, the admin console's user list and name search, answers 500
on some pages and searches and 200 on others. The route-errors alert for that
endpoint fires. Each failing request logs `Response validation failed:` from
`ZodResponseInterceptor` with an issue at `data.<n>.zip`, message
`Must be valid Zip code`, followed by an `InternalServerErrorException`. No
other route is affected in the telemetry. There is no user-facing impact
outside staff, and no data is lost: the admin simply gets no results.

## Mechanism

- `ReadUserOutputSchema` (in `packages/contracts/src/users/`) is built by
  extending `CreateUserInputSchema`, and it kept that schema's `zip`, which is
  `ZipSchema`: a refine over `validator.isPostalCode(val, 'US')`.
- That is a signup-form rule. The database column is `zip String?` with no
  format constraint, so rows exist whose zip never passed it (legacy imports,
  older write paths, free text).
- `ZodResponseInterceptor` parses every response against its declared schema
  and throws a 500 on any failure. `GET /v1/users` declares
  `PaginatedResponseSchema(ReadUserOutputSchema)`, so Zod validates the whole
  `data` array: one bad row anywhere on the page fails the entire response.
- Which searches fail depends only on whether the page they return happens to
  contain such a user, which is why the failure looks intermittent.
- The same mistake was already fixed for `firstName` and `lastName` in this
  schema, with a comment giving the same reasoning. `zip` was left strict and
  has been latent since the omni cutover.

## What a correct fix does

- Stops the read path rejecting data the database already holds, for this
  route and every route that returns a user through the same schema.
- Keeps the write path strict: creating or updating a user with a malformed
  zip is still refused.
- Does not delete, rewrite or hide stored users.

Acceptable shapes include relaxing `zip` on the read schema (the merged fix),
normalising or sanitising the value on read, or validating per row rather
than per page. A data migration that cleans today's rows does not, on its own,
fix it: the column still accepts the next bad value.

## Evidence a good investigation cites

- The error lines for the route, with the `data.<n>.zip` issue path and the
  `Must be valid Zip code` message.
- The ratio of failing to succeeding `GET /v1/users` requests over the window,
  with the query behind it.
- The schema lineage: `ReadUserOutputSchema` extends `CreateUserInputSchema`,
  and `zip` is not overridden where `firstName`/`lastName` are.

## Worth noting, not required

`phone` on the same schema has the identical shape (`makeOptional(PhoneSchema)`
over an unconstrained `String?`) and is the same latent bug with no failures
yet. A good post-mortem mentions it; widening the fix to it is a judgement
call, not a requirement.
