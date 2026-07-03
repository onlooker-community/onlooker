import { logger } from "@onlooker/logger";
import { createClient } from "redis";
import type { RedisClient } from "@/types/client";
import {
	type CacheError,
	ErrorCode,
	err,
	ok,
	type Result,
} from "@/types/error";
import { CacheService } from "./service";

/**
 * Creates a Redis client from the REDIS_URL environment variable
 * @returns Result containing RedisClient or RedisConfigurationError if REDIS_URL is not set
 */
export async function createRedisClientFromEnv(): Promise<
	Result<RedisClient, CacheError>
> {
	const url = process.env.REDIS_URL;
	if (!url) {
		logger.error("REDIS_URL is required to create the Redis client");
		return err({
			code: ErrorCode.RedisConfigurationError,
		});
	}

	const client = createClient({
		url,
		socket: {
			connectTimeout: 3000,
		},
	});

	client.on("error", (error) => {
		logger.error(error, "Redis client error");
		try {
			resetCacheFactory();
			client.destroy();
		} catch (e) {
			logger.error(e, "Error destroying Redis client");
		}
	});

	client.on("connect", () => {
		logger.info("Redis client connected");
	});

	client.on("ready", () => {
		logger.info("Redis client ready");
	});

	client.on("end", () => {
		logger.info("Redis client disconnected");
	});

	try {
		await client.connect();
		return ok(client as RedisClient);
	} catch (error) {
		logger.error(error, "Redis client connection failed");
		return err({ code: ErrorCode.RedisConnectionError });
	}
}

// Global singleton with globalThis for cross-module sharing
const globalForCache = globalThis as unknown as {
	onlookerCache: CacheService | undefined;
	onlookerCacheInitializing:
		| Promise<Result<CacheService, CacheError>>
		| undefined;
};

// Module-level singleton for performance
let singleton: CacheService | null = globalForCache.onlookerCache ?? null;

/**
 * Returns existing instance immediately if available
 * Creates a cache service instance instead if not available
 * Fails fast if Redis is not available - consumers handle reconnection
 */
export async function getCacheService(): Promise<
	Result<CacheService, CacheError>
> {
	// Return existing instance immediately
	if (singleton) {
		const rc = singleton.getRedisClient();
		if (rc?.isReady && rc.isOpen) return ok(singleton);
	}

	// Return existing instance from globalForCache if available
	if (globalForCache.onlookerCache) {
		const rc = globalForCache.onlookerCache.getRedisClient();
		if (rc?.isReady && rc.isOpen) {
			singleton = globalForCache.onlookerCache;
			return ok(globalForCache.onlookerCache);
		}
	}

	// Prevent concurrent initialization
	if (globalForCache.onlookerCacheInitializing) {
		const result = await globalForCache.onlookerCacheInitializing;
		if (result.ok) {
			singleton = result.data;
		}
		return result;
	}

	// Start initialization - fail fast approach
	globalForCache.onlookerCacheInitializing = (async (): Promise<
		Result<CacheService, CacheError>
	> => {
		const clientResult = await createRedisClientFromEnv();
		if (!clientResult.ok) {
			logger.error(
				{ error: clientResult.error },
				"Redis client creation failed",
			);
			return err({ code: clientResult.error.code });
		}

		const client = clientResult.data;
		logger.debug("Redis connection established");
		const svc = new CacheService(client);
		singleton = svc;
		globalForCache.onlookerCache = svc;
		logger.debug("Cache service created");
		return ok(svc);
	})();

	const result = await globalForCache.onlookerCacheInitializing;
	if (!result.ok) {
		globalForCache.onlookerCacheInitializing = undefined; // Allow retry
		logger.error({ error: result.error }, "Cache service creation failed");
	}
	return result;
}

export function resetCacheFactory(): void {
	singleton = null;
	globalForCache.onlookerCache = undefined;
	globalForCache.onlookerCacheInitializing = undefined;
}
