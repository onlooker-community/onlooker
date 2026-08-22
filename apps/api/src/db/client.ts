import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";

/**
 * The drizzle client is constructed per call rather than passed in, so
 * signatures stay identical to the raw-D1 versions they replaced. Construction
 * is a thin wrapper over the binding, not a connection.
 *
 * The one drizzle client. Imported, never re-declared - two factories that
 * drift apart have no symptom until one is configured differently.
 */
export const client = (db: D1Database) => drizzle(db);
