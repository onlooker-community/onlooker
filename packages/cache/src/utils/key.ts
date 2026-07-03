import { logger } from "@onlooker/logger";
import type { CacheKey } from "@/types/keys";

/**
 * Helper function to create cache keys with runtime validation
 * Automatically adds "ol:" prefix and validates structure
 *
 * @param parts - Cache key parts (resource, identifier, subresources...)
 * @returns Validated CacheKey
 *
 * @example
 * makeCacheKey("env", "123", "state") // Returns "ol:env:123:state"
 * makeCacheKey("user", "456") // Returns "ol:user:456"
 */
export const makeCacheKey = (
	...parts: [first: string, ...rest: string[]]
): CacheKey => {
	if (parts[0] === "ol") {
		logger.error(
			"Invalid Cache key: Do not include 'ol' prefix, it's added automatically",
		);
		throw new Error(
			"Invalid Cache key: Do not include 'ol' prefix, it's added automatically",
		);
	}

	// Check for empty parts
	if (parts.some((part) => part.length === 0)) {
		logger.error("Invalid Cache key: Parts cannot be empty");
		throw new Error("Invalid Cache key: Parts cannot be empty");
	}

	const key = `ol:${parts.join(":")}`;

	// Valid format: starts with "ol:", has valid structure
	if (!/^ol:(?:[^:]+)(?::[^:]+)*$/.test(key)) {
		logger.error("Invalid Cache key: Invalid structure");
		throw new Error("Invalid Cache key: Invalid structure");
	}

	return key as CacheKey;
};
