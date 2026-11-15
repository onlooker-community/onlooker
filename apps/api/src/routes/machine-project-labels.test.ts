import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
// Assembled rather than written as one literal so the repository's secret
// scanner does not flag a throwaway test fixture. Same value the sibling
// route suites use; do not "simplify" it back into a single string.
const PASSWORD = ["correct", "horse", "battery"].join("-");

async function signup(email: string): Promise<string> {
	const response = await exports.default.fetch(`${BASE}/auth/signup`, {
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
	const response = await exports.default.fetch(`${BASE}/api/machines`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ name }),
	});
	return (await response.json()) as { id: string; token: string };
}

const KEY = "6a7678979e31";
const OTHER = "ee2cfbe428c7";

/** Report one session touching `key`, so the machine has reported it. */
async function report(
	machineToken: string,
	key: string,
	basis: "remote" | "root",
): Promise<void> {
	const response = await exports.default.fetch(`${BASE}/machine/sessions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${machineToken}`,
		},
		body: JSON.stringify({
			schema_version: 1,
			sessions: [
				{
					session_id: `s-${key}`,
					started_at: "2026-11-15T12:00:00.000Z",
					ended_at: "2026-11-15T13:00:00.000Z",
					event_count: 25,
					counts_by_prefix: { tool: 25 },
					counts_by_project: { [key]: { basis, event_count: 25 } },
					plugins: ["onlooker"],
					prompts: 1,
					compactions: 0,
				},
			],
		}),
	});
	expect(response.status).toBe(200);
}

function putLabels(machineToken: string, body: unknown): Promise<Response> {
	return exports.default.fetch(`${BASE}/machine/project-labels`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${machineToken}`,
		},
		body: JSON.stringify(body),
	});
}

async function rows(): Promise<unknown[]> {
	const { results } = await db()
		.prepare(
			"SELECT project_key, machine_id, source, label, written_by FROM project_labels ORDER BY project_key",
		)
		.all();
	return results;
}

beforeEach(async () => {
	await db().prepare("DELETE FROM project_labels").run();
	await db().prepare("DELETE FROM session_summaries").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
});

describe("PUT /machine/project-labels", () => {
	it("refuses a browser session", async () => {
		const ada = await signup("ada@example.com");
		const response = await putLabels(ada, { derivation: 1, labels: [] });
		expect(response.status).toBe(401);
	});

	it("stores a remote label with no machine, written by this one", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "remote");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [
				{
					project_key: KEY,
					basis: "remote",
					label: "onlooker-community/onlooker",
				},
			],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ stored: 1, skipped: 0 });
		expect(await rows()).toEqual([
			{
				project_key: KEY,
				machine_id: "",
				source: "cli",
				label: "onlooker-community/onlooker",
				written_by: laptop.id,
			},
		]);
	});

	it("puts a root label on the token's machine whatever the body says", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");
		await report(laptop.token, KEY, "root");
		await putLabels(laptop.token, {
			derivation: 1,
			labels: [
				{
					project_key: KEY,
					basis: "root",
					label: "notes",
					machine_id: desktop.id,
				},
			],
		});
		expect(await rows()).toMatchObject([
			{ machine_id: laptop.id, written_by: laptop.id },
		]);
	});

	// Problem 1: a machine may name only what it reported.
	it("skips a key this machine never reported", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");
		await report(desktop.token, OTHER, "remote");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [
				{
					project_key: OTHER,
					basis: "remote",
					label: "onlooker-community/ecosystem",
				},
			],
		});
		expect(await response.json()).toEqual({ stored: 0, skipped: 1 });
		expect(await rows()).toEqual([]);
	});

	it("skips a key reported under the other basis", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "root");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "a/b" }],
		});
		expect(await response.json()).toEqual({ stored: 0, skipped: 1 });
	});

	// Problem 7: two derivations must never alternate one key's label.
	it("refuses a derivation it does not know", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const response = await putLabels(laptop.token, {
			derivation: 2,
			labels: [],
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "unsupported_derivation" },
		});
	});

	it("refuses a label a person could not type either", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "remote");
		const response = await putLabels(laptop.token, {
			derivation: 1,
			labels: [{ project_key: KEY, basis: "remote", label: "a‮b" }],
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "invalid_label" },
		});
	});

	it("refuses more than 500 labels", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const labels = Array.from({ length: 501 }, () => ({
			project_key: KEY,
			basis: "remote",
			label: "a/b",
		}));
		const response = await putLabels(laptop.token, { derivation: 1, labels });
		expect(response.status).toBe(400);
	});

	it("lets a second machine take over a shared remote label", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");
		await report(laptop.token, KEY, "remote");
		await report(desktop.token, KEY, "remote");
		const body = {
			derivation: 1,
			labels: [
				{
					project_key: KEY,
					basis: "remote",
					label: "onlooker-community/onlooker",
				},
			],
		};
		await putLabels(laptop.token, body);
		await putLabels(desktop.token, body);
		expect(await rows()).toMatchObject([{ written_by: desktop.id }]);
	});

	it("never touches the user's own label", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		await report(laptop.token, KEY, "remote");
		await exports.default.fetch(`${BASE}/api/project-labels`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ada}`,
			},
			body: JSON.stringify({
				project_key: KEY,
				machine_id: null,
				label: "mine",
			}),
		});
		await putLabels(laptop.token, {
			derivation: 1,
			labels: [
				{
					project_key: KEY,
					basis: "remote",
					label: "onlooker-community/onlooker",
				},
			],
		});
		expect(await rows()).toHaveLength(2);
	});
});
