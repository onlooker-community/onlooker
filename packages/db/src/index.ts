/**
 * @onlooker/db - Database schema and types
 *
 * This package provides the database schema definitions, TypeScript types, and
 * migration setup for the Onlooker platform using Drizzle ORM and SQLite (D1).
 *
 * ## Usage
 *
 * Import types and schema:
 * ```typescript
 * import {
 *   users,
 *   sessions,
 *   type User,
 *   type Session,
 * } from "@onlooker/db";
 * ```
 *
 * Connect to D1 and query:
 * ```typescript
 * import { drizzle } from "drizzle-orm/d1";
 * import * as schema from "@onlooker/db";
 *
 * export interface Env {
 *   DB: D1Database;
 * }
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const db = drizzle(env.DB, { schema });
 *     const user = await db.query.users.findFirst({
 *       where: (users, { eq }) => eq(users.id, userId),
 *     });
 *     return new Response(JSON.stringify(user));
 *   },
 * };
 * ```
 */

export * from "./schema.js";
