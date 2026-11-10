import { beforeEach, describe, expect, it } from "vitest";
import { createMockFetch } from "./mockApi";

// The mock's org fixture, tested for what mock mode can DEMONSTRATE rather
// than for shape - the contract already pins shape. OrgsPage gates its delete
// control on an owned org whose member list has exactly one entry (ONL-136's
// D5), and its role and remove controls are only worth anything with someone
// else in the roster. A fixture with one org can satisfy one of those and not
// the other, which is how the delete branch went unreachable. ONL-148.

let fetchMock: ReturnType<typeof createMockFetch>;
let token: string;

async function get<T>(path: string): Promise<T> {
	const response = await fetchMock(path, {
		method: "GET",
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(response.status).toBe(200);
	return (await response.json()) as T;
}

/** Member count of every org the caller owns. */
async function ownedMemberCounts(): Promise<number[]> {
	const { orgs } = await get<{ orgs: { id: string; role: string }[] }>(
		"/api/orgs",
	);
	return Promise.all(
		orgs
			.filter((org) => org.role === "owner")
			.map(
				async (org) =>
					(await get<{ members: unknown[] }>(`/api/orgs/${org.id}/members`))
						.members.length,
			),
	);
}

beforeEach(async () => {
	fetchMock = createMockFetch();
	const signup = await fetchMock("/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: `orgs-${crypto.randomUUID()}@example.com`,
			password: crypto.randomUUID(),
			name: "Org Fixture Account",
		}),
	});
	expect(signup.status).toBe(201);
	token = ((await signup.json()) as { token: string }).token;
});

describe("the mock's org fixture", () => {
	it("includes an owned org with exactly one member, so the delete control renders", async () => {
		expect(await ownedMemberCounts()).toContain(1);
	});

	it("still includes an owned org with someone else in it, for the role controls", async () => {
		const counts = await ownedMemberCounts();
		expect(counts.some((count) => count > 1)).toBe(true);
	});

	it("404s the member list of an org outside the fixture", async () => {
		const response = await fetchMock("/api/orgs/org-does-not-exist/members", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(404);
	});

	// The machine picker lists every org from GET /api/orgs, so every one of
	// them must be one the mint's membership check accepts - otherwise mock
	// mode offers an org and then 404s for choosing it.
	it("accepts a machine mint bound to any org it lists", async () => {
		const { orgs } = await get<{ orgs: { id: string }[] }>("/api/orgs");
		for (const org of orgs) {
			const response = await fetchMock("/api/machines", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ name: "work laptop", org_id: org.id }),
			});
			expect(response.status, org.id).toBe(201);
		}
	});
});
