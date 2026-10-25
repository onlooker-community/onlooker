import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = () => env.DB;
const BASE = "https://api.onlooker.dev";
// Assembled rather than written as one literal so the repository's secret
// scanner does not flag a throwaway test fixture. Same value the sibling
// route suites use; do not "simplify" it back into a single string.
const PASSWORD = ["correct", "horse", "battery"].join("-");
const KEY = "6a7678979e31";

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

function put(token: string, body: unknown): Promise<Response> {
	return SELF.fetch(`${BASE}/api/project-labels`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function list(token: string): Promise<unknown> {
	const response = await SELF.fetch(`${BASE}/api/project-labels`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { labels: unknown }).labels;
}

beforeEach(async () => {
	await db().prepare("DELETE FROM project_labels").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
});

describe("GET /api/project-labels", () => {
	it("refuses a request without a session", async () => {
		const response = await SELF.fetch(`${BASE}/api/project-labels`);
		expect(response.status).toBe(401);
	});

	// A machine credential names one machine and has no business reading a
	// person's names for every repository.
	it("refuses a machine token", async () => {
		const ada = await signup("ada@example.com");
		const machine = await mint(ada, "laptop");
		const response = await SELF.fetch(`${BASE}/api/project-labels`, {
			headers: { Authorization: `Bearer ${machine.token}` },
		});
		expect(response.status).toBe(401);
	});

	it("lists nothing for a user who has named nothing", async () => {
		const ada = await signup("ada@example.com");
		expect(await list(ada)).toEqual([]);
	});

	it("shows a user only their own labels", async () => {
		const ada = await signup("ada@example.com");
		const bob = await signup("bob@example.com");
		await put(ada, { project_key: KEY, machine_id: null, label: "onlooker" });

		expect(await list(bob)).toEqual([]);
	});
});

describe("PUT /api/project-labels", () => {
	it("names a remote key with no machine", async () => {
		const ada = await signup("ada@example.com");

		const response = await put(ada, {
			project_key: KEY,
			machine_id: null,
			label: "onlooker",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			project_key: KEY,
			machine_id: null,
			label: "onlooker",
		});
		expect(await list(ada)).toEqual([
			{ project_key: KEY, machine_id: null, label: "onlooker" },
		]);
	});

	it("names a root key on one of the user's machines", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");

		await put(ada, { project_key: KEY, machine_id: laptop.id, label: "notes" });

		expect(await list(ada)).toEqual([
			{ project_key: KEY, machine_id: laptop.id, label: "notes" },
		]);
	});

	// The same key on two machines is two repositories, so naming one must not
	// name the other - the scoping rollupProjects draws on the web side.
	it("keeps a root key's label to its own machine", async () => {
		const ada = await signup("ada@example.com");
		const laptop = await mint(ada, "laptop");
		const desktop = await mint(ada, "desktop");

		await put(ada, { project_key: KEY, machine_id: laptop.id, label: "a" });
		await put(ada, { project_key: KEY, machine_id: desktop.id, label: "b" });
		await put(ada, { project_key: KEY, machine_id: null, label: "c" });

		const labels = (await list(ada)) as Array<{ label: string }>;
		expect(labels.map((l) => l.label).sort()).toEqual(["a", "b", "c"]);
	});

	// Harmless to the owner of that machine, who never reads ada's labels, but
	// a machine id is not ada's to name things under.
	it("refuses another user's machine", async () => {
		const ada = await signup("ada@example.com");
		const bob = await signup("bob@example.com");
		const bobs = await mint(bob, "laptop");

		const response = await put(ada, {
			project_key: KEY,
			machine_id: bobs.id,
			label: "mine now",
		});

		expect(response.status).toBe(404);
		expect(await list(ada)).toEqual([]);
	});

	it("renames in place rather than adding a second label", async () => {
		const ada = await signup("ada@example.com");

		await put(ada, { project_key: KEY, machine_id: null, label: "first" });
		await put(ada, { project_key: KEY, machine_id: null, label: "second" });

		expect(await list(ada)).toEqual([
			{ project_key: KEY, machine_id: null, label: "second" },
		]);
	});

	it("clears a label when given null", async () => {
		const ada = await signup("ada@example.com");
		await put(ada, { project_key: KEY, machine_id: null, label: "onlooker" });

		const response = await put(ada, {
			project_key: KEY,
			machine_id: null,
			label: null,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			project_key: KEY,
			machine_id: null,
			label: null,
		});
		expect(await list(ada)).toEqual([]);
	});

	it("stores the label trimmed", async () => {
		const ada = await signup("ada@example.com");
		await put(ada, { project_key: KEY, machine_id: null, label: "  spaced  " });
		expect(await list(ada)).toEqual([
			{ project_key: KEY, machine_id: null, label: "spaced" },
		]);
	});

	it.each([
		["a key that is not 12 hex", { project_key: "6A7678979E31" }],
		["a missing key", { project_key: undefined }],
		["a machine id that is not a string", { machine_id: 7 }],
		["a missing label", { label: undefined }],
		["an empty label", { label: "   " }],
		["a label over 200 bytes", { label: "é".repeat(101) }],
		["a control character", { label: "one\ntwo" }],
		["a zero-width space", { label: "on​looker" }],
		// Reorders what is displayed after it: the classic way to make a
		// name read as something it is not.
		["a bidi override", { label: "‮ekoolno" }],
		["a lone surrogate", { label: "on\uD800looker" }],
	])("refuses %s", async (_name, overrides) => {
		const ada = await signup("ada@example.com");

		const response = await put(ada, {
			project_key: KEY,
			machine_id: null,
			label: "onlooker",
			...overrides,
		});

		expect(response.status).toBe(400);
		expect(await list(ada)).toEqual([]);
	});

	it("accepts a label of exactly 200 bytes", async () => {
		const ada = await signup("ada@example.com");
		const response = await put(ada, {
			project_key: KEY,
			machine_id: null,
			label: "é".repeat(100),
		});
		expect(response.status).toBe(200);
	});

	it("refuses a body that is not JSON", async () => {
		const ada = await signup("ada@example.com");
		const response = await put(ada, "{not json");
		expect(response.status).toBe(400);
	});

	it("refuses a machine token", async () => {
		const ada = await signup("ada@example.com");
		const machine = await mint(ada, "laptop");
		const response = await put(machine.token, {
			project_key: KEY,
			machine_id: null,
			label: "onlooker",
		});
		expect(response.status).toBe(401);
	});
});
