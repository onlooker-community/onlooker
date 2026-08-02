import type { Config } from "drizzle-kit";

export default {
	schema: "./src/schema.ts",
	out: "./migrations",
	dialect: "sqlite",
	driver: "d1",
	dbCredentials: {
		wranglerConfigPath: "../../wrangler.toml",
		dbName: "onlooker",
	},
} satisfies Config;
