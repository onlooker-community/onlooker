import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_REFRESH_LEAD_MS, EXPIRY_WARNING_LEAD_MS } from "../auth";

// These two numbers only make sense relative to a third one that lives in
// another app's config, so nothing local can tell you they are wrong. Read the
// real value rather than restating it: a copy here would agree with itself
// forever while the deployed API drifted away.
function tokenLifetimeMs(): number {
	const wrangler = readFileSync(
		join(__dirname, "../../../api/wrangler.toml"),
		"utf8",
	);

	const values = [
		...wrangler.matchAll(/^TOKEN_EXPIRY_MINUTES\s*=\s*"(\d+)"/gm),
	].map((m) => Number(m[1]));

	// Every environment must agree, or "the token lifetime" is not one number
	// and these leads cannot be correct for all of them.
	expect(
		values.length,
		"no TOKEN_EXPIRY_MINUTES found in wrangler.toml",
	).toBeGreaterThan(0);
	expect(
		new Set(values).size,
		`environments disagree: ${values.join(", ")}`,
	).toBe(1);

	return values[0] * 60_000;
}

describe("session lead times", () => {
	// The ordering is the whole point. SessionExpiryBanner is a role="alert"
	// plate with a countdown; if the warning fires before the automatic refresh,
	// every healthy session displays it on every token and it comes to mean
	// "time is passing" rather than "something went wrong".
	//
	// The defaults in @onlooker/auth-react are the wrong way round (refresh at
	// 1 min, warn at 5), which is survivable at a three-hour token and absurd at
	// a fifteen-minute one.
	it("renews before it warns", () => {
		expect(AUTO_REFRESH_LEAD_MS).toBeGreaterThan(EXPIRY_WARNING_LEAD_MS);
	});

	// A lead longer than the token means the condition is true from the moment
	// the token is issued - a banner that is always up, or a refresh that fires
	// immediately and loops.
	it("both leads fit inside the token lifetime the API issues", () => {
		const lifetime = tokenLifetimeMs();

		expect(AUTO_REFRESH_LEAD_MS).toBeLessThan(lifetime);
		expect(EXPIRY_WARNING_LEAD_MS).toBeLessThan(lifetime);
	});

	// Leaving room for the request itself, retries and a backgrounded tab whose
	// timers were throttled. Firing the renewal in the last sliver of a token's
	// life is how a session dies while the code believes it is being kept alive.
	it("leaves the renewal enough of the token to actually happen", () => {
		expect(AUTO_REFRESH_LEAD_MS).toBeGreaterThanOrEqual(
			tokenLifetimeMs() * 0.1,
		);
	});
});
