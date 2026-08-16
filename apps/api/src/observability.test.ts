import { describe, expect, it } from "vitest";
// Inlined by Vite at build time rather than read with node:fs. These tests run
// in workerd, whose sandbox cannot see arbitrary files in the repository - a
// readFileSync here fails with "no such file or directory" on a path that
// plainly exists.
import websiteConfigRaw from "../../website/wrangler.jsonc?raw";
import apiConfigRaw from "../wrangler.toml?raw";

// Telemetry that turns itself off is worse than none, because the silence reads
// as health. This whole epic exists because the browser produced no signal and
// nobody noticed for months; a traces flag quietly dropped from a config would
// reproduce that on the server side.
//
// A config test can only prove the file says the right thing. Whether the
// deployed Worker is actually emitting traces is visible in the Cloudflare
// dashboard and nowhere else - noted on onlooker-k34.2 rather than pretended at
// here.

const apiConfig = () => apiConfigRaw;
const websiteConfig = () => websiteConfigRaw;

describe("tracing stays on", () => {
	// Explicit because Cloudflare says so: while automatic tracing is in beta,
	// observability.enabled turns on logs ONLY. Someone tidying this file might
	// reasonably assume the traces block is redundant. It is not.
	it("is enabled for the API, at the top level", () => {
		expect(apiConfig()).toMatch(/\[observability\.traces\]\s*\nenabled = true/);
	});

	// Declared per environment as well, because Wrangler's documentation does
	// not say whether named environments inherit `observability`, and the cost
	// of guessing wrong is no telemetry from the two environments anyone looks
	// at - while the top-level block makes it read as though it is on.
	it("is enabled for every deployed environment, not only the top level", () => {
		const config = apiConfig();

		for (const env of ["staging", "production"]) {
			expect(config, `traces not declared for env.${env}`).toMatch(
				new RegExp(
					`\\[env\\.${env}\\.observability\\.traces\\]\\s*\\nenabled = true`,
				),
			);
		}
	});

	it("is enabled for the website", () => {
		expect(websiteConfig()).toMatch(/"traces":\s*\{\s*"enabled":\s*true/);
	});

	// Sampling is the setting most likely to be added casually and then
	// forgotten. At ~368 requests a day it would make a thin dataset thinner,
	// and a sampled trace of an incident that happened once is no trace at all.
	// If this ever fails, the question to answer is whether traffic actually
	// justifies it - not to delete the test.
	it("traces everything, because there is not enough traffic to sample", () => {
		// Matches an assignment, not the word. Both files explain in prose why
		// sampling is absent, and a looser pattern failed on that explanation -
		// a test that cannot tell a setting from a comment about the setting.
		expect(apiConfig()).not.toMatch(/^\s*head_sampling_rate\s*=/m);
		expect(websiteConfig()).not.toMatch(/"head_sampling_rate"\s*:/);
	});
});
