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
 * A comparator-prefixed version range: "<6", ">=4", ">=4 <6", ">=4.1.2".
 *
 * A bare "4" is rejected deliberately. It could mean "exactly 4" or "4 and
 * above", and this field decides whether a lesson is still true, so an
 * ambiguous value is worse than a rejected one.
 *
 * Kept as a regex rather than a refinement so it survives into the emitted
 * JSON Schema as `pattern`, where plugins can enforce the same rule.
 */
export const VERSION_RANGE =
	/^(<|<=|>|>=|=)\d+(\.\d+)?(\.\d+)?( (<|<=|>|>=|=)\d+(\.\d+)?(\.\d+)?)?$/;
