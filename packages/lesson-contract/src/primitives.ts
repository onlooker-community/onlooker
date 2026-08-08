import { z } from "zod";

/**
 * ULID in Crockford base32, matching the archivist artifact convention
 * (for example 01KZ45MKAM734ZS7JK24D2DK0R). Uppercase only; I, L, O and U
 * are excluded from the alphabet.
 *
 * Expressed as a regex rather than a refinement on purpose: refinements are
 * silently dropped by z.toJSONSchema, so they would not reach the plugins
 * that validate against the published artifact.
 */
export const ZUlid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type TUlid = z.infer<typeof ZUlid>;

/**
 * Opaque 12-character hex project hash. The project_key to remote_url
 * mapping lives only in the local manifest.json, so a shared lesson carries
 * technical facts without revealing which repository produced them.
 */
export const ZProjectKey = z.string().regex(/^[0-9a-f]{12}$/);
export type TProjectKey = z.infer<typeof ZProjectKey>;

/**
 * Opaque 32-character hex author identifier, derived per visibility scope as
 * HMAC(user_secret, scope). Pinning the format matters: this field carries
 * the unlinkability guarantee, and an unconstrained string would happily
 * accept a plaintext email address.
 *
 * Deliberately wider than ZProjectKey. project_key is a local-only label with
 * no security role, while author_key is what org revocation and public
 * blocking act on, so a collision would block an innocent author alongside a
 * bad actor. 128 bits makes that negligible; truncating further buys nothing,
 * because the field is not size-constrained anywhere that matters.
 */
export const ZAuthorKey = z
	.string()
	.regex(/^[0-9a-f]{32}$/)
	.describe(
		"Derived per visibility scope from the author's secret; not " +
			"linkable across scopes.",
	);
export type TAuthorKey = z.infer<typeof ZAuthorKey>;

const VERSION_PART = String.raw`\d+(\.\d+)?(\.\d+)?`;

/**
 * All-zero version part: "0", "0.0", "0.0.0" (and multi-digit runs like
 * "00" or "0.00"). Used below to keep a single-sided lower bound from
 * being vacuous — see VERSION_RANGE.
 */
const ZERO_VERSION = String.raw`0+(\.0+)?(\.0+)?`;

/**
 * A comparator-prefixed version range: "<6", ">=4", ">=4 <6", ">=4.1.2".
 *
 * A bare "4" is rejected deliberately. It could mean "exactly 4" or "4 and
 * above", and this field decides whether a lesson is still true, so an
 * ambiguous value is worse than a rejected one.
 *
 * A single-sided lower bound whose version is entirely zeros — ">=0",
 * ">=0.0", ">=0.0.0", and ">0" by the same reasoning — is rejected too. It
 * excludes nothing real: every release that exists is greater than literal
 * 0, so it would match every session forever and never reach the
 * version_independent justification gate that the scope design exists to
 * enforce. ">0" does technically exclude the exact version 0, unlike
 * ">=0"; it is rejected anyway because no real package ships that version,
 * so the exclusion is vacuous in practice. Non-zero pre-1.0 bounds like
 * ">=0.5" and ">0.9.1" are unaffected — they exclude a real range of
 * versions and stay meaningful. The same "0" is legal again once it is
 * paired with an upper bound (">=0 <6"), because the range is already
 * structurally finite from the upper side.
 *
 * A two-sided range must read lower bound first, upper bound second, so
 * ">4 >6", "<4 <2" and "=4 <6" are all rejected. Without that constraint a
 * pair of same-facing comparators would validate as a "range" while
 * describing no interval at all.
 *
 * Residual limitation: ">6 <2" still validates. Rejecting it means comparing
 * magnitudes, which a regex cannot do and which .refine() must not do here
 * (refinements vanish from the emitted JSON Schema). That check belongs with
 * the other cross-field rules in server-side ingest.
 *
 * Built with RegExp rather than a literal so the pattern stays inside the
 * 80-column limit; z.toJSONSchema reads .source either way, so it still
 * emits as `pattern`.
 */
export const VERSION_RANGE = new RegExp(
	`^((<|<=|=)${VERSION_PART}` +
		`|(>|>=)(?!${ZERO_VERSION}$)${VERSION_PART}` +
		`|(>|>=)${VERSION_PART} (<|<=)${VERSION_PART})$`,
);
