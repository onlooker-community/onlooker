import react from "@vitejs/plugin-react";
// vitest/config, not vite: this config carries a `test` block, and only
// vitest's defineConfig types it. Under vite's own the object fell to the last
// overload and reported `test` as an unknown property - invisible to
// `pnpm typecheck`, which includes only src/, but an error in every editor.
import { defineConfig } from "vitest/config";

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

		// Every icon is a few hundred bytes, so all 80 fall under Vite's default
		// 4096-byte inline limit and land in the JS chunk as base64 - measured
		// at 30,064 bytes, 9.0% of what production shipped on 2026-09-07, and
		// most of it for icons no page renders.
		//
		// Returning false emits them as hashed files instead. The eager glob in
		// Icon.tsx keeps working unchanged; it yields short URLs rather than
		// data URIs, and the unrendered icons then cost disk in dist rather than
		// payload, because nobody fetches a file no page references.
		//
		// A function rather than a smaller number, so this applies to the icons
		// and leaves every other asset on Vite's own size test. `undefined`
		// means "no opinion" - it is not the same as returning false.
		assetsInlineLimit: (filePath: string) =>
			filePath.includes("packages/brand/icons/") ? false : undefined,
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
