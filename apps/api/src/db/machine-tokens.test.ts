import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createMachineToken,
	listMachineTokens,
	removeMachineToken,
	revokeMachineToken,
	verifyMachineToken,
} from "./machine-tokens.js";
import { createOrgWithOwner } from "./orgs.js";
import { createUser } from "./queries.js";
import { putSessionSummaries } from "./session-summaries.js";

const db = () => env.DB;

let userId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM session_summaries").run();
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(db(), "m@example.com", "hash", "Ada");
	userId = user.id;
});

describe("createMachineToken", () => {
	it("returns a prefixed token of 32 random bytes in hex", async () => {
		const { token } = await createMachineToken(db(), userId, "work laptop");

		expect(token).toMatch(/^onlk_[0-9a-f]{64}$/);
	});

	// The raw value is a bearer credential: whoever holds one can push lessons
	// as this user. A read of the table must not produce a working token.
	it("stores a hash, never the raw token", async () => {
		const { token } = await createMachineToken(db(), userId, "work laptop");

		const row = await db()
			.prepare("SELECT token_hash FROM machine_tokens")
			.first<{ token_hash: string }>();

		expect(row?.token_hash).not.toBe(token);
		expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("never issues the same token twice", async () => {
		const a = await createMachineToken(db(), userId, "one");
		const b = await createMachineToken(db(), userId, "two");

		expect(a.token).not.toBe(b.token);
	});
});

describe("verifyMachineToken", () => {
	it("resolves a live token to its user", async () => {
		const { token } = await createMachineToken(db(), userId, "work laptop");

		expect(await verifyMachineToken(db(), token)).toMatchObject({ userId });
	});

	// The owner is not enough to know which machine is speaking, and a machine
	// reporting its own inventory has to land on its own row. The id is
	// already selected by the lookup, so carrying it costs no extra query.
	it("says which machine the token belongs to, not only who owns it", async () => {
		const { id, token } = await createMachineToken(db(), userId, "work laptop");

		expect(await verifyMachineToken(db(), token)).toEqual({
			userId,
			machineId: id,
			orgId: null,
		});
	});

	it("distinguishes two machines owned by the same person", async () => {
		const laptop = await createMachineToken(db(), userId, "laptop");
		const desktop = await createMachineToken(db(), userId, "desktop");

		const a = await verifyMachineToken(db(), laptop.token);
		const b = await verifyMachineToken(db(), desktop.token);

		expect(a?.machineId).toBe(laptop.id);
		expect(b?.machineId).toBe(desktop.id);
		expect(a?.machineId).not.toBe(b?.machineId);
	});

	it("rejects a token that was never issued", async () => {
		expect(await verifyMachineToken(db(), `onlk_${"0".repeat(64)}`)).toBeNull();
	});

	it("rejects a revoked token", async () => {
		const { id, token } = await createMachineToken(db(), userId, "lost laptop");
		await revokeMachineToken(db(), userId, id);

		expect(await verifyMachineToken(db(), token)).toBeNull();
	});

	// The whole point of per-row revocation. If this fails, revoking a stolen
	// laptop takes every other machine offline with it.
	it("leaves other machines working when one is revoked", async () => {
		const lost = await createMachineToken(db(), userId, "lost laptop");
		const kept = await createMachineToken(db(), userId, "desktop");

		await revokeMachineToken(db(), userId, lost.id);

		expect(await verifyMachineToken(db(), kept.token)).toMatchObject({
			userId,
		});
	});

	it("records when the token was last used", async () => {
		const { token } = await createMachineToken(db(), userId, "work laptop");
		await verifyMachineToken(db(), token);

		const row = await db()
			.prepare("SELECT last_used_at FROM machine_tokens")
			.first<{ last_used_at: string | null }>();

		expect(row?.last_used_at).not.toBeNull();
	});
});

describe("revokeMachineToken", () => {
	// Ownership is checked in the query, not only in the route. A route is one
	// caller; the query is every caller.
	it("will not revoke a token belonging to someone else", async () => {
		const other = await createUser(db(), "b@example.com", "hash", "Bob");
		const { id, token } = await createMachineToken(db(), userId, "mine");

		expect(await revokeMachineToken(db(), other.id, id)).toBe(false);
		// Still live, and still this user's - a failed revoke must leave the
		// token working rather than merely returning false.
		expect(await verifyMachineToken(db(), token)).toMatchObject({ userId });
	});
});

describe("listMachineTokens", () => {
	it("lists this user's machines without any token material", async () => {
		await createMachineToken(db(), userId, "work laptop");

		const [machine] = await listMachineTokens(db(), userId);

		expect(machine.name).toBe("work laptop");
		expect(JSON.stringify(machine)).not.toContain("onlk_");
		expect(JSON.stringify(machine)).not.toContain("token_hash");
	});
});

describe("a token bound to an org", () => {
	let orgId: string;

	beforeEach(async () => {
		orgId = (await createOrgWithOwner(db(), "Acme", userId)).id;
	});

	it("carries the org through verification", async () => {
		const created = await createMachineToken(db(), userId, "laptop", orgId);

		const verified = await verifyMachineToken(db(), created.token);

		expect(verified).toMatchObject({ userId, orgId });
	});

	it("verifies a token minted without an org as private-only", async () => {
		// Every token in production today is this one. Null here is what keeps
		// a deploy from changing what an existing machine may push.
		const created = await createMachineToken(db(), userId, "laptop");

		const verified = await verifyMachineToken(db(), created.token);

		expect(verified?.orgId).toBeNull();
	});

	it("reports the org in the list", async () => {
		await createMachineToken(db(), userId, "laptop", orgId);

		const [summary] = await listMachineTokens(db(), userId);

		expect(summary.org_id).toBe(orgId);
	});
});

describe("removeMachineToken", () => {
	it("marks a revoked machine removed, and the list still returns it", async () => {
		const { id } = await createMachineToken(db(), userId, "old laptop");
		await revokeMachineToken(db(), userId, id);

		expect(await removeMachineToken(db(), userId, id)).toBe(true);

		const [machine] = await listMachineTokens(db(), userId);
		expect(machine?.id).toBe(id);
		expect(machine?.removed_at).not.toBeNull();
	});

	// A live credential must not vanish from the page while it still works.
	it("will not remove a live machine", async () => {
		const { id } = await createMachineToken(db(), userId, "live");

		expect(await removeMachineToken(db(), userId, id)).toBe(false);
		const [machine] = await listMachineTokens(db(), userId);
		expect(machine?.removed_at).toBeNull();
	});

	it("will not remove a machine belonging to someone else", async () => {
		const other = await createUser(db(), "b@example.com", "hash", "Bob");
		const { id } = await createMachineToken(db(), userId, "mine");
		await revokeMachineToken(db(), userId, id);

		expect(await removeMachineToken(db(), other.id, id)).toBe(false);
		const [machine] = await listMachineTokens(db(), userId);
		expect(machine?.removed_at).toBeNull();
	});

	it("will not remove a machine twice, or one that never existed", async () => {
		const { id } = await createMachineToken(db(), userId, "old");
		await revokeMachineToken(db(), userId, id);
		await removeMachineToken(db(), userId, id);

		expect(await removeMachineToken(db(), userId, id)).toBe(false);
		expect(await removeMachineToken(db(), userId, "no-such-id")).toBe(false);
	});

	// This exists to catch a future hard delete: session_summaries.machine_id
	// cascades, so deleting the row would take the machine's history with it.
	it("keeps the sessions the machine reported", async () => {
		const { id } = await createMachineToken(db(), userId, "old laptop");
		await putSessionSummaries(db(), userId, id, [
			{
				session_id: "s1",
				started_at: "2026-01-01T00:00:00.000Z",
				ended_at: "2026-01-01T01:00:00.000Z",
				event_count: 3,
				counts_by_prefix: { tool: 3 },
				counts_by_project: {},
				plugins: [],
				prompts: 1,
				compactions: 0,
			},
		]);
		await revokeMachineToken(db(), userId, id);
		await removeMachineToken(db(), userId, id);

		const row = await db()
			.prepare("SELECT session_id FROM session_summaries WHERE machine_id = ?")
			.bind(id)
			.first<{ session_id: string }>();
		expect(row?.session_id).toBe("s1");
	});
});
