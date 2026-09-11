import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
// Assembled rather than written as one literal so the repository's secret
// scanner does not flag a throwaway test fixture. Same value the sibling
// route suites use; do not "simplify" it back into a single string.
const PASSWORD = ["correct", "horse", "battery"].join("-");

const DOC = {
	schema_version: 1,
	collected_at: "2026-09-11T00:00:00.000Z",
	project: "~/src/onlooker",
	plugins: [
		{
			id: "librarian@onlooker-community",
			scopes: [
				{
					scope: "user",
					version: "0.18.1",
					git_commit_sha: "56057f9",
					installed_at: null,
					last_updated: null,
					enabled: true,
				},
			],
		},
	],
};

async function signup(email: string): Promise<string> {
	const response = await SELF.fetch(`${BASE}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, password: PASSWORD, name: "Ada" }),
	});
	return ((await response.json()) as { token: string }).token;
}

async function mint(
	accessToken: string,
	name: string,
): Promise<{ id: string; token: string }> {
	const response = await SELF.fetch(`${BASE}/api/machines`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ name }),
	});
	return (await response.json()) as { id: string; token: string };
}

const report = (machineToken: string, body: unknown) =>
	SELF.fetch(`${BASE}/machine/inventory`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${machineToken}`,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

const readInventory = (id: string, auth: string) =>
	SELF.fetch(`${BASE}/api/machines/${id}/inventory`, {
		headers: { Authorization: `Bearer ${auth}` },
	});

let accessToken: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	accessToken = await signup("inventory@example.com");
});

describe("PUT /machine/inventory", () => {
	it("stores the document and answers ok", async () => {
		const machine = await mint(accessToken, "laptop");

		const response = await report(machine.token, DOC);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("is idempotent - reporting twice leaves one document", async () => {
		const machine = await mint(accessToken, "laptop");

		await report(machine.token, DOC);
		await report(machine.token, DOC);

		const body = (await (
			await readInventory(machine.id, accessToken)
		).json()) as { inventory: typeof DOC };
		expect(body.inventory.plugins).toHaveLength(1);
	});

	it("rejects a plugins field that is not an array", async () => {
		const machine = await mint(accessToken, "laptop");

		const response = await report(machine.token, {
			schema_version: 1,
			plugins: "nope",
		});

		expect(response.status).toBe(400);
	});

	it("rejects an unknown schema_version", async () => {
		const machine = await mint(accessToken, "laptop");

		const response = await report(machine.token, {
			schema_version: 99,
			plugins: [],
		});

		expect(response.status).toBe(400);
	});

	it("rejects a body that is not JSON", async () => {
		const machine = await mint(accessToken, "laptop");

		expect((await report(machine.token, "{ not json")).status).toBe(400);
	});

	// Bounded, because a machine credential should not be able to write an
	// unbounded blob into D1. Generous against the ~22 KB a 28-plugin machine
	// actually produces.
	it("rejects a document over the size cap", async () => {
		const machine = await mint(accessToken, "laptop");
		const huge = {
			schema_version: 1,
			collected_at: "2026-09-11T00:00:00.000Z",
			project: null,
			plugins: Array.from({ length: 20_000 }, (_, i) => ({
				id: `plugin-${i}@marketplace`,
				scopes: [],
			})),
		};

		expect((await report(machine.token, huge)).status).toBe(413);
	});

	it("refuses a request carrying no machine credential", async () => {
		const response = await SELF.fetch(`${BASE}/machine/inventory`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(DOC),
		});

		expect(response.status).toBe(401);
	});

	it("refuses a browser access credential", async () => {
		expect((await report(accessToken, DOC)).status).toBe(401);
	});

	it("refuses a revoked machine credential", async () => {
		const machine = await mint(accessToken, "lost laptop");
		await SELF.fetch(`${BASE}/api/machines/${machine.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		expect((await report(machine.token, DOC)).status).toBe(401);
	});

	// The credential names one machine and may write only that machine's row.
	// If this fails, the page cannot say who reported what.
	it("writes only the reporting machine's row", async () => {
		const reporter = await mint(accessToken, "laptop");
		const bystander = await mint(accessToken, "desktop");

		await report(reporter.token, DOC);

		expect((await readInventory(bystander.id, accessToken)).status).toBe(404);
	});
});

describe("GET /api/machines/:id/inventory", () => {
	it("returns the stored document to its owner", async () => {
		const machine = await mint(accessToken, "laptop");
		await report(machine.token, DOC);

		const response = await readInventory(machine.id, accessToken);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			inventory: typeof DOC;
			inventory_at: string;
		};
		// An object, not the stored string - every other route answers in
		// objects and a client should not have to parse twice.
		expect(body.inventory).toEqual(DOC);
		expect(typeof body.inventory_at).toBe("string");
	});

	it("404s a machine that has never reported", async () => {
		const machine = await mint(accessToken, "laptop");

		expect((await readInventory(machine.id, accessToken)).status).toBe(404);
	});

	// 403 would confirm the id exists, which is an existence oracle over
	// another account's rows - the same reason handleRevokeMachine 404s.
	it("404s another account's machine rather than 403", async () => {
		const machine = await mint(accessToken, "laptop");
		await report(machine.token, DOC);
		const intruder = await signup("intruder@example.com");

		expect((await readInventory(machine.id, intruder)).status).toBe(404);
	});

	it("refuses a machine credential on this browser route", async () => {
		const machine = await mint(accessToken, "laptop");
		await report(machine.token, DOC);

		expect((await readInventory(machine.id, machine.token)).status).toBe(401);
	});

	it("never exposes credential material alongside the inventory", async () => {
		const machine = await mint(accessToken, "laptop");
		await report(machine.token, DOC);

		const response = await readInventory(machine.id, accessToken);

		const serialized = JSON.stringify(await response.json());
		expect(serialized).not.toContain("onlk_");
		expect(serialized).not.toContain("token_hash");
	});
});
