import { getViteConfig } from "astro/config";

// getViteConfig rather than a bare defineConfig: it wires up Astro's own vite
// plugins, which is what makes `import Layout from "../layouts/Layout.astro"`
// resolve in a test. Without it the credit check can only read the layout as
// text, and a string in a source file does not establish that anything renders.
//
// configFile: false skips astro.config.mjs, and that is deliberate rather than
// laziness. Loading it brings in the Cloudflare adapter's vite plugin, which
// refuses to run under vitest - it rejects the `resolve.external` that vitest's
// ssr environment sets. Nothing rendered here needs the adapter or the env
// schema; only middleware.ts reads astro:env, and no test imports it.
export default getViteConfig(
	{ test: { include: ["src/**/*.test.ts"] } },
	{ configFile: false },
);
