import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	build: {
		// Without this, every client error reported to /api/client-errors
		// arrives as a stack pointing into minified code - index-<hash>.js at
		// column 24518 - which names nothing and locates nothing. The reporting
		// was built after a render throw blanked the dashboard for every
		// logged-in user; it would have caught that error and been unable to
		// say where it came from.
		//
		// Emitted with the reference comment rather than hidden, because this
		// repository is public. Hiding maps protects source that is already on
		// GitHub, and costs the ability to read a stack in devtools against
		// production.
		//
		// Maps make a reported stack readable, not automatically read. Mapping
		// one is still manual today - see onlooker-k34 for what a vendor would
		// add on top of this.
		sourcemap: true,
	},
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
