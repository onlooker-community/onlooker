/**
 * Where the local dev seed writes (ONL-300), and nowhere else.
 *
 * Constants rather than options on purpose: there is no flag or environment
 * variable that points the seed at another database or API, so it cannot be
 * aimed at staging or production by a mistyped command. local.test.ts pins
 * it, in place of the CI step the old bash seed had.
 */

/** The D1 database `wrangler dev --env development` uses. */
export const LOCAL_DATABASE = "onlooker-db-local";

/** Where `pnpm dev` serves the API. */
export const LOCAL_API = "http://localhost:8787";

/** Arguments for `pnpm` that run one SQL file against the local database. */
export function wranglerArgs(sqlFile: string): string[] {
	return [
		"--filter",
		"@onlooker/api",
		"exec",
		"wrangler",
		"d1",
		"execute",
		LOCAL_DATABASE,
		"--local",
		"--env",
		"development",
		"--file",
		sqlFile,
	];
}
