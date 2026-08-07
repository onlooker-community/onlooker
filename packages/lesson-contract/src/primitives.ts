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

const VERSION_PART = String.raw`\d+(\.\d+)?(\.\d+)?`;
const COMPARATOR = "(<|<=|>|>=|=)";

/**
 * A comparator-prefixed version range: "<6", ">=4", ">=4 <6", ">=4.1.2".
 *
 * A bare "4" is rejected deliberately. It could mean "exactly 4" or "4 and
 * above", and this field decides whether a lesson is still true, so an
 * ambiguous value is worse than a rejected one.
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
	`^(${COMPARATOR}${VERSION_PART}|(>|>=)${VERSION_PART} (<|<=)${VERSION_PART})$`,
);
