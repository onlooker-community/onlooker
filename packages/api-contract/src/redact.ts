/**
 * Remove credential-shaped strings before they are sent or written down.
 *
 * Lives here, rather than in either app, because both sides need it and they
 * need it for different reasons. apps/web scrubs so a secret never crosses the
 * network; apps/api scrubs so nothing secret-shaped is ever written to a log,
 * whoever sent it. Neither substitutes for the other, and a second copy of
 * these patterns would drift - which is the failure this package exists to
 * prevent elsewhere.
 *
 * It was once weighed against @onlooker/logger, which read as the natural home
 * and was rejected because that package depended on pino and
 * pino-opentelemetry-transport while apps/web is a browser bundle. That package
 * has since been deleted outright, for the same reason scaled up: nothing on
 * Cloudflare can run a Node logger, so it never gained a consumer.
 *
 * What is at stake: two routes carry a single-use credential in the path, and
 * the ordinary shape of a network error is "Failed to fetch <that URL>". A
 * password-reset token exists only in someone's inbox until something copies it
 * somewhere else.
 */

/**
 * Tokens issued by this system: 32 random bytes, hex encoded.
 *
 * Matched by shape rather than by position, because the route list below is not
 * a guarantee - a future route carrying a token would not be on it, and a stack
 * trace can carry one anywhere. 32+ hex characters is long enough that ordinary
 * prose does not collide with it.
 */
const TOKEN_SHAPED = /\b[0-9a-f]{32,}\b/gi;

/** A JWT, which is what an Authorization header carries. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Routes that put a single-use credential in the path.
 *
 * The segment must be at least 16 characters, which is what keeps this from
 * eating ordinary path segments. `/auth/reset-password/verify` is a real
 * endpoint and `verify` is not a secret - redacting it made a production log
 * line say less than it could while protecting nothing. Tokens here are 64
 * characters, so the floor costs nothing.
 */
const SECRET_PATH = /\/(reset-password|verify-email)\/[^/?#\s]{16,}/gi;

/**
 * Query parameters worth emptying wherever they appear.
 *
 * Stops at punctuation as well as at `&` and whitespace. These strings are
 * usually quoted inside a stack frame - `at fetch (…?token=abc)` - and a
 * greedy match swallows the closing bracket along with the token, leaving a
 * malformed frame in the one place someone is reading carefully.
 */
const SECRET_PARAM = /([?&](?:token|password|secret|key)=)[^&\s)\]}"'>]+/gi;

/**
 * Strip anything credential-shaped out of a string.
 *
 * Four passes, because the failure modes differ: the known routes catch the
 * common case legibly, the token and JWT shapes catch it wherever else it
 * surfaces, and the parameter pass catches the reset-verify call.
 *
 * Over-redaction has a cost too. A report with nothing identifiable left is not
 * worth sending or storing, which is why this targets shapes rather than, say,
 * dropping every path segment.
 */
export function redactSecrets(value: string): string;
export function redactSecrets(value: undefined): undefined;
export function redactSecrets(value: string | undefined): string | undefined;
export function redactSecrets(value: string | undefined): string | undefined {
	if (!value) return value;

	return value
		.replace(SECRET_PATH, (_match, route) => `/${route}/[redacted]`)
		.replace(SECRET_PARAM, "$1[redacted]")
		.replace(JWT_SHAPED, "[redacted]")
		.replace(TOKEN_SHAPED, "[redacted]");
}
