/**
 * A delivery that failed its adapter's verification or could not be parsed.
 * It exists so the webhook routes can answer 401 for a misconfigured contact
 * point and 500 for a broken Boss, instead of collapsing both into one.
 *
 * It lives here rather than beside ingest so bugboss/http does not have to
 * import the composition root that mounts it.
 */
export class IngestRejected extends Error {}
