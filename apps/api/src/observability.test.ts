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

// A stack trace that names errorHandler but points at line 31,402 of a bundle
// is readable only in the sense that it is not minified. Wrangler writes
// index.js.map beside the worker on every build and, unless told otherwise,
// uploads none of it - so nothing maps that line back to
// apps/api/src/middleware/error.ts. The flag is the whole difference between a
// bundle line and a source line.
describe("worker stacks resolve to source", () => {
	// Per environment rather than at the top level, for the reason the traces
	// block above gives and one this file learned the hard way: `routes` was
	// declared at the top level, inheritance handed a nameless worker the
	// production hostname with no bindings, and only luck kept it off the
	// account. An inheritable key that matters is declared where it applies.
	// Read the one table rather than regexing across the file. A pattern like
	// /\[env\.staging\][\s\S]*?upload_source_maps = true/ passes when staging
	// has no flag and production does, because nothing stops it running past
	// the section it names - it would have reported this feature working with
	// staging unconfigured.
	//
	// Bounding it at the next table also enforces the TOML placement: the key
	// belongs to [env.<name>], so it has to appear before [env.<name>.vars] or
	// it silently becomes a key of that table instead.
	const envTable = (config: string, env: string): string => {
		const lines = config.split("\n");
		const start = lines.indexOf(`[env.${env}]`);
		expect(start, `no [env.${env}] table`).toBeGreaterThan(-1);
		const rest = lines.slice(start + 1);
		const end = rest.findIndex((line) => line.startsWith("["));
		return (end === -1 ? rest : rest.slice(0, end)).join("\n");
	};

	it("uploads source maps from every deployed environment", () => {
		const config = apiConfig();

		for (const env of ["staging", "production"]) {
			expect(
				envTable(config, env),
				`source maps not uploaded for env.${env}`,
			).toMatch(/^upload_source_maps = true$/m);
		}
	});

	// Matches an assignment, not the word, for the same reason the sampling
	// test does: the prose above explains what the flag is for, and a pattern
	// that cannot tell the two apart would pass on the comment alone.
	it("does not leave the flag off anywhere it is mentioned", () => {
		expect(apiConfig()).not.toMatch(/^\s*upload_source_maps\s*=\s*false/m);
	});
});
