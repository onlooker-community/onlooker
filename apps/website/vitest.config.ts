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
//
// `test` is Vitest's, but getViteConfig is typed against a nested Vite 7
// UserConfig (via @cloudflare/vite-plugin) that does not declare it. Naming
// the object skips excess-property checking so the intersection is
// assignable; a literal in the call site is not. vitest/config's
// defineConfig cannot wrap this: it returns the workspace Vite 8
// UserConfig, which is a different type from that nested copy.
const vitestConfig: Parameters<typeof getViteConfig>[0] & {
	test: { include: string[] };
} = {
	test: { include: ["src/**/*.test.ts"] },
};
export default getViteConfig(vitestConfig, { configFile: false });
