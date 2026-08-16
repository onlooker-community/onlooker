/**
 * `import config from "./wrangler.toml?raw"` — Vite inlines the file's contents
 * as a string at build time.
 *
 * Used by observability.test.ts to assert against configuration files. These
 * tests run in workerd, whose sandbox cannot see arbitrary files in the
 * repository, so `node:fs` fails on paths that plainly exist. Inlining is the
 * way to read a config file from inside a Worker test.
 */
declare module "*?raw" {
	const content: string;
	export default content;
}
