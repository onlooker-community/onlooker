import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// This app is a client-routed SPA served as Workers static assets. Every route
// below "/" exists only in React Router, so the server has to answer unmatched
// paths with index.html rather than 404 - otherwise the document never loads
// and the router never runs.
//
// It shipped without that setting and 404'd every deep link in production:
// bookmarks, refreshes, shared links, and every link in a password-reset email.
// Nobody noticed because loading "/" and navigating from there never touches
// it, and that is what developing the app looks like.
//
// A unit test cannot prove the deployed behavior - only curl against the real
// hostname does, and that is recorded in onlooker-hu8. What this can do is stop
// the config from being dropped again, which is the failure that actually
// happened.
function webWranglerConfig(): string {
	return readFileSync(join(__dirname, "../../wrangler.toml"), "utf8");
}

describe("static asset routing", () => {
	it("serves index.html for unmatched paths", () => {
		expect(webWranglerConfig()).toMatch(
			/not_found_handling\s*=\s*"single-page-application"/,
		);
	});

	// Declared once at the top level so it applies to every environment. Set per
	// environment instead and one of them silently keeps 404ing - which is worse
	// than the original bug, because the working environment makes it look fixed.
	it("declares it once, above the environment blocks", () => {
		const config = webWranglerConfig();
		const setting = config.indexOf("not_found_handling");
		const firstEnv = config.indexOf("[env.");

		expect(setting).toBeGreaterThan(-1);
		expect(setting).toBeLessThan(firstEnv);
	});

	// Every path the app routes has to be one the server will hand the SPA. A
	// route added to App.tsx that the config cannot serve is the same bug again.
	it("has no server-side route list that could fall behind App.tsx", () => {
		const config = webWranglerConfig();

		// The fix is a blanket fallback, not an enumeration. If someone replaces
		// it with a list of paths, that list starts rotting the day it is written.
		expect(config).not.toMatch(/not_found_handling\s*=\s*"404-page"/);
	});
});
