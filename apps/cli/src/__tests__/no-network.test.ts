import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../api";
import { takeReached } from "./no-network-setup";

// Port 9 is discard: if the guard is missing, these tests fail on a refused
// connection instead of sending anything anywhere that matters.
const NOWHERE = "http://127.0.0.1:9";

describe("the test network guard", () => {
	// Each test here reaches the guard on purpose, so it takes the record
	// before the setup file's own afterEach would fail it.
	afterEach(() => {
		takeReached();
	});

	it("refuses a request no test stubbed", async () => {
		await expect(fetch(`${NOWHERE}/lessons`)).rejects.toThrow(
			/reached the network/,
		);
		expect(takeReached()).toEqual([`${NOWHERE}/lessons`]);
	});

	// The ONL-197 incident: a client built without a fetchImpl fell back to the
	// real fetch and sent a DELETE to production. The client turns a thrown
	// fetch into "Could not reach", so a test expecting a failure still passed.
	it("catches a client that falls back to the global fetch", async () => {
		await expect(
			createClient(NOWHERE, "tok").deleteProjectLabels(),
		).rejects.toThrow(/reached the network/);
		expect(takeReached()).toEqual([`${NOWHERE}/machine/project-labels`]);
	});

	it("comes back after a test's own stub is undone", async () => {
		vi.stubGlobal("fetch", vi.fn());
		vi.unstubAllGlobals();
		await expect(fetch(`${NOWHERE}/after`)).rejects.toThrow(
			/reached the network/,
		);
	});
});
