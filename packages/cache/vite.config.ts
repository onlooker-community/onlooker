/// <reference types="vitest" />
import { resolve } from "node:path";
import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";
import { rewriteNodeNextDtsSpecifiers } from "../vite-plugins/node-next-dts";

export default defineConfig({
	resolve: {
		alias: {
			"@": resolve(__dirname, "."),
		},
	},
	build: {
		lib: {
			entry: resolve(__dirname, "src/index.ts"),
			name: "onlookerCache",
			fileName: "index",
			formats: ["es", "cjs"],
		},
		rollupOptions: {
			external: ["redis", "@onlooker/logger", "zod"],
		},
	},
	plugins: [
		dts({
			include: ["src/**/*", "types/**/*"],
			entryRoot: ".",
			outDirs: ["dist"],
			beforeWriteFile: rewriteNodeNextDtsSpecifiers,
		}),
	],
	test: {
		environment: "node",
		globals: true,
		coverage: {
			reporter: ["text", "json", "html", "lcov"],
		},
	},
});
