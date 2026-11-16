import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		setupFiles: ["src/__tests__/no-network-setup.ts"],
	},
});
