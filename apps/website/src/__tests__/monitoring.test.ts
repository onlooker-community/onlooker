import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { websiteMonitoringConfig } from "../lib/monitoring";

/**
 * Repository files are read with node:fs rather than Vite's `?raw`.
 *
 * apps/api/src/monitoring.test.ts uses `?raw` because its tests run in workerd,
 * which cannot see arbitrary repository files. This app's vitest has no workers
 * pool, so the reason does not carry over and a plain read says what it does.
 */
function repoFile(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const deployWorkflow = () =>
	repoFile("../../../../.github/workflows/deploy.yml");
const astroConfig = () => repoFile("../../astro.config.mjs");
const turboConfig = () => repoFile("../../../../turbo.json");

describe("websiteMonitoringConfig", () => {
	// Without a release Sentry cannot mark a deploy, call an issue a
	// regression, or name a suspect commit. The website had none at all until
	// this existed: the source map upload carried a release sentry-cli guessed
	// from git, and the running worker reported nothing, so the two halves
	// described the same deploy under two different names.
	it("stamps events with the commit the deploy shipped", () => {
		expect(
			websiteMonitoringConfig({ MONITORING_RELEASE: "0f1e2d3c4b5a" }).release,
		).toBe("0f1e2d3c4b5a");
	});

	// Undefined rather than a stand-in like "unknown" or "dev". A made-up
	// release name still creates a release in Sentry, one that no source map
	// upload will ever match, so every stack filed under it stays minified.
	it("leaves the release unset when the deploy supplied none", () => {
		expect(websiteMonitoringConfig({}).release).toBeUndefined();
	});

	it("passes the DSN through, and stays off without one", () => {
		expect(
			websiteMonitoringConfig({ SENTRY_DSN: "https://k@o1.i/1" }).dsn,
		).toBe("https://k@o1.i/1");
		expect(websiteMonitoringConfig({}).dsn).toBeUndefined();
	});

	// Production, unlike apps/api's development default. This worker has one
	// deployed environment and no staging counterpart, so an unlabeled event
	// here did come from production. Preserved from the inline config this
	// factory replaced rather than chosen afresh.
	it("labels events with the environment, defaulting to production", () => {
		expect(
			websiteMonitoringConfig({ SENTRY_ENVIRONMENT: "development" })
				.environment,
		).toBe("development");
		expect(websiteMonitoringConfig({}).environment).toBe("production");
	});
});

/**
 * The release only ever arrives from the deploy, so the deploy is the only
 * place it can go missing - and it would go missing silently. Nothing fails
 * without one; Sentry files every event under no release, which reads exactly
 * like a project nobody has deployed.
 */
describe("the deploy supplies the release", () => {
	it("passes the commit to the website worker", () => {
		expect(deployWorkflow()).toContain(
			// Escaped in a template literal rather than written as a plain
			// string, so biome's noTemplateCurlyInString does not read GitHub's
			// ${{ }} as a mistyped interpolation. Same idiom as
			// apps/api/src/monitoring.test.ts:79.
			`pnpm deploy:website --var MONITORING_RELEASE:\${{ github.sha }}`,
		);
	});

	// The same commit on all three, because they are three halves of one
	// deploy: the browser bundle stamps events, the worker stamps events, and
	// the source map upload files artifacts. A release that differs across any
	// of those boundaries describes one deploy as two.
	for (const variable of ["SENTRY_RELEASE", "PUBLIC_MONITORING_RELEASE"]) {
		it(`builds the site with ${variable} set to the commit`, () => {
			expect(deployWorkflow()).toContain(`${variable}: \${{ github.sha }}`);
		});
	}

	// Turbo restores `build` from cache on an input hash. A release variable
	// absent from that hash is not an input, so a rebuild at a new commit can
	// be served the previous commit's bundle with the previous commit's
	// release baked into it - and report it for as long as that cache lives.
	for (const variable of ["SENTRY_RELEASE", "PUBLIC_MONITORING_RELEASE"]) {
		it(`counts ${variable} as an input to the build`, () => {
			expect(JSON.parse(turboConfig()).tasks.build.env).toContain(variable);
		});
	}
});

/**
 * The regression guard for onlooker-0tnr.8.
 *
 * @sentry/astro reads vite.build.sourcemap to decide two things, and the
 * second one is not obvious: when the setting is *unset* it both forces maps
 * on and auto-sets sourcemaps.filesToDeleteAfterUpload, deleting every map
 * after upload. astro+cloudflare runs vite three times and the plugin uploads
 * once per pass, so the first pass uploaded nine maps and deleted them, and a
 * later pass re-uploaded those same nine debug ids with no map against them.
 *
 * Pinning the setting to any explicit value is what stops that. Deleting the
 * pin restores the bug silently - the build stays green and the maps simply
 * stop arriving.
 */
describe("source maps survive the build", () => {
	it("pins vite.build.sourcemap so the plugin does not arm its own cleanup", () => {
		expect(astroConfig()).toMatch(/vite:\s*{\s*build:\s*{[^}]*sourcemap:/);
	});
});
