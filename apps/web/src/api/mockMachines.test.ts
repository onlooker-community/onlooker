import { beforeEach, describe, expect, it } from "vitest";
import { createMockFetch } from "./mockApi";

// The mock's machine lifecycle, tested on its own rather than only through the
// shared contract. The contract pins what both implementations must agree on;
// this pins the parts that only exist so the page can be developed at all -
// that a second machine appears in the list, that a revoked one stays visible
// and marked. A contract case would have to be true of apps/api too, and
// several of these are about the mock's in-memory store specifically.

let fetchMock: ReturnType<typeof createMockFetch>;
let token: string;

async function mint(name: string) {
	return fetchMock("/api/machines", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ name }),
	});
}

async function list() {
	return fetchMock("/api/machines", {
		method: "GET",
		headers: { Authorization: `Bearer ${token}` },
	});
}

// A distinct account per test rather than the shared seeded one. MACHINES in
// mockApi.ts is keyed by email and lives for the whole file's test run - the
// mock has no per-test reset, and api-contract.test.ts depends on that: it
// calls createMockFetch() fresh per case and still expects a machine minted
// in one case to be listable in the next. A shared account here would let
// machines minted by an earlier test in this file leak into a later test's
// list, which is exactly what "keeps every machine" and "starts a fresh
// machine as never used" are checking is NOT true.
let mockMachineTestAccountCounter = 0;

beforeEach(async () => {
	fetchMock = createMockFetch();
	mockMachineTestAccountCounter += 1;
	const email = `machines-${mockMachineTestAccountCounter}@example.com`;
	const signup = await fetchMock("/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email,
			password: "password123",
			name: "Machine Test Account",
		}),
	});
	expect(signup.status).toBe(201);
	token = ((await signup.json()) as { token: string }).token;
});

describe("the mock's machine lifecycle", () => {
	it("hands back a token shaped like the one apps/api mints", async () => {
		const response = await mint("work laptop");
		expect(response.status).toBe(201);
		const created = (await response.json()) as { id: string; token: string };
		// Same shape as createMachineToken: the prefix is what secret scanners
		// grep for, and the contract's forbidden list greps for it too. A mock
		// minting a different shape would let a leak through on the one side
		// the gate cannot see.
		expect(created.token).toMatch(/^onlk_[0-9a-f]{64}$/);
		expect(created.id).toBeTruthy();
	});

	it("never returns the token again once it has been minted", async () => {
		const created = (await (await mint("work laptop")).json()) as {
			token: string;
		};
		const body = await (await list()).text();
		expect(body).not.toContain(created.token);
		expect(body).not.toContain("onlk_");
	});

	it("starts a fresh machine as never used", async () => {
		await mint("work laptop");
		const { machines } = (await (await list()).json()) as {
			machines: Array<{ name: string; last_used_at: string | null }>;
		};
		expect(machines).toHaveLength(1);
		// Null, not an empty string and not omitted. The page renders a
		// distinct "Never used" treatment off exactly this, and a "" would
		// render as a blank cell - the failure the treatment exists to prevent.
		expect(machines[0].last_used_at).toBeNull();
	});

	it("keeps every machine the account has minted", async () => {
		await mint("work laptop");
		await mint("desktop");
		const { machines } = (await (await list()).json()) as {
			machines: Array<{ name: string }>;
		};
		expect(machines.map((m) => m.name)).toEqual(["work laptop", "desktop"]);
	});

	it("rejects a name that is only whitespace", async () => {
		const response = await mint("   ");
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error?: { code?: string } };
		expect(JSON.stringify(body)).toContain("invalid_name");
	});

	it("marks a revoked machine rather than dropping it from the list", async () => {
		const { id } = (await (await mint("stolen laptop")).json()) as {
			id: string;
		};
		const revoke = await fetchMock(`/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(revoke.status).toBe(200);

		const { machines } = (await (await list()).json()) as {
			machines: Array<{ id: string; revoked_at: string | null }>;
		};
		// listMachineTokens in apps/api selects every row for the user with no
		// filter on revoked_at, so the mock keeps them too. A user who revokes
		// a laptop should be able to see that they did.
		expect(machines).toHaveLength(1);
		expect(machines[0].revoked_at).not.toBeNull();
	});

	it("404s a second revoke of the same machine", async () => {
		const { id } = (await (await mint("stolen laptop")).json()) as {
			id: string;
		};
		await fetchMock(`/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		const again = await fetchMock(`/api/machines/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		// revokeMachineToken filters on isNull(revoked_at) and returns false
		// when nothing matched, which handleRevokeMachine turns into a 404.
		// Answering 200 twice would tell a user the second revoke did something.
		expect(again.status).toBe(404);
	});

	it("404s a machine id that was never minted", async () => {
		const response = await fetchMock("/api/machines/does-not-exist", {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(404);
	});

	it("refuses every verb without a token", async () => {
		for (const init of [
			{ method: "GET" },
			{ method: "POST", body: JSON.stringify({ name: "x" }) },
			{ method: "DELETE" },
		] as RequestInit[]) {
			const path =
				init.method === "DELETE" ? "/api/machines/anything" : "/api/machines";
			expect((await fetchMock(path, init)).status).toBe(401);
		}
	});
});
