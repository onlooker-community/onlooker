import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
	},
	test: {
		globals: true,
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: ["dist/**/*", "node_modules/**/*"],
	},
});
