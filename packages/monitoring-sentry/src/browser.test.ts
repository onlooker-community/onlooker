import type { Integration } from "@sentry/core";
import { describe, expect, it } from "vitest";
import { browserOptions } from "./browser";

const config = { dsn: undefined, environment: "development" } as const;
const defaults = [
	{ name: "GlobalHandlers" },
	{ name: "Breadcrumbs" },
] as Integration[];
const replay = { name: "Replay" } as Integration;

function names(integrations: Integration[]) {
	return integrations.map(({ name }) => name);
}

describe("browserOptions", () => {
	it("drops Sentry's global listeners when the app has its own", () => {
		const options = browserOptions(config, {
			captureGlobalErrors: false,
			integrations: [replay],
		});

		expect(names(options.integrations(defaults))).toEqual([
			"Breadcrumbs",
			"Replay",
		]);
	});

	it("keeps them when the app relies on them", () => {
		const options = browserOptions(config, { captureGlobalErrors: true });

		expect(names(options.integrations(defaults))).toEqual([
			"GlobalHandlers",
			"Breadcrumbs",
		]);
	});

	it("carries the shared privacy options", () => {
		const options = browserOptions(config, { captureGlobalErrors: true });

		expect(options.sendDefaultPii).toBe(false);
	});
});
