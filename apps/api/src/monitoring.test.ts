import { describe, expect, it } from "vitest";
// Inlined by Vite rather than read with node:fs, for the reason
// observability.test.ts gives: these run in workerd, which cannot see
// arbitrary repository files.
import deployWorkflowRaw from "../../../.github/workflows/deploy.yml?raw";
import { monitoringConfig } from "./monitoring";
import type { WorkerEnv } from "./types";

/**
 * A deployed env with only the fields monitoring reads filled in.
 *
 * The rest are present because WorkerEnv requires them, not because this cares
 * what they hold.
 */
function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
	return {
		JWT_SECRET: "x".repeat(32),
		TOKEN_EXPIRY_MINUTES: "15",
		REFRESH_TOKEN_EXPIRY_DAYS: "30",
		DB: {} as WorkerEnv["DB"],
		CORS_ORIGIN: "https://app.onlooker.dev",
		EMAIL_FROM: "Onlooker <noreply@onlooker.dev>",
		APP_BASE_URL: "https://app.onlooker.dev",
		...overrides,
	};
}

describe("monitoringConfig", () => {
	// Without a release Sentry cannot mark a deploy, call an issue a
	// regression, or name a suspect commit - which is most of what it offers
	// over grepping Workers Logs.
	it("stamps events with the commit the deploy shipped", () => {
		const config = monitoringConfig(
			envWith({ MONITORING_RELEASE: "0f1e2d3c4b5a" }),
		);

		expect(config.release).toBe("0f1e2d3c4b5a");
	});

	// Undefined rather than a stand-in like "unknown" or "dev". A made-up
	// release name still creates a release in Sentry, one that no source map
	// upload will ever match, so every stack filed under it stays minified.
	it("leaves the release unset when the deploy supplied none", () => {
		expect(monitoringConfig(envWith()).release).toBeUndefined();
	});

	it("labels events with the environment it is deployed to", () => {
		expect(
			monitoringConfig(envWith({ ENVIRONMENT: "production" })).environment,
		).toBe("production");
	});

	// development, not production: an unrecognized value here is a local or
	// test worker, and guessing production would page someone for a laptop.
	it("falls back to development for an environment it does not know", () => {
		expect(monitoringConfig(envWith()).environment).toBe("development");
	});

	it("passes the DSN through, and stays off without one", () => {
		expect(
			monitoringConfig(envWith({ MONITORING_DSN: "https://k@o1.i/1" })).dsn,
		).toBe("https://k@o1.i/1");
		expect(monitoringConfig(envWith()).dsn).toBeUndefined();
	});
});

/**
 * The var is only ever set by the deploy, so the deploy is the only place it
 * can go missing - and it would go missing silently. Nothing at runtime fails
 * without a release; Sentry just quietly files every event under none, which
 * reads exactly like a project nobody has deployed.
 */
describe("the deploy supplies the release", () => {
	const workflow = () => deployWorkflowRaw;

	for (const script of ["deploy:api:staging", "deploy:api:prod"]) {
		it(`passes the commit to ${script}`, () => {
			expect(workflow()).toContain(
				`pnpm ${script} --var MONITORING_RELEASE:\${{ github.sha }}`,
			);
		});
	}

	// The same value on both halves of the app, because a trace crosses from
	// the browser into the worker and a release that differs across that
	// boundary describes one deploy as two.
	it("builds the web bundle with the same commit", () => {
		expect(workflow()).toContain("VITE_MONITORING_RELEASE: ${{ github.sha }}");
	});
});
