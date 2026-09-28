/**
 * A delivery that failed its adapter's verification or could not be parsed.
 * It exists so the webhook routes can answer 401 for a misconfigured contact
 * point and 500 for a broken Boss, instead of collapsing both into one.
 *
 * It lives here rather than beside ingest so bugboss/http does not have to
 * import the composition root that mounts it.
 */
export class IngestRejected extends Error {}

/**
 * The request body could not be read to the end, because the caller went away
 * mid-delivery. Distinct from every other failure on these routes: it is a
 * fact about the client rather than about us, so it must not fire the alarm
 * that stands for a dropped alert.
 *
 * A type rather than a message match. The obvious shortcut is to pattern-match
 * the error text in `onError`, and it is wrong: the AWS SDK's own socket
 * failures inside `db.withWrite` throw messages of the same shape, so a real
 * failed write on the ingest path would be demoted to a client disconnect —
 * silently, on the one path where silence is the thing this system exists to
 * prevent. Raised only where the body is read, so nothing else can be mistaken
 * for it.
 */
export class BodyUnreadable extends Error {}
