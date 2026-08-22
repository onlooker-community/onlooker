import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createMachineToken,
	listMachineTokens,
	revokeMachineToken,
	verifyMachineToken,
} from "./machine-tokens.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

let userId: string;

beforeEach(async () => {
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

		expect(await verifyMachineToken(db(), token)).toBe(userId);
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

		expect(await verifyMachineToken(db(), kept.token)).toBe(userId);
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
		expect(await verifyMachineToken(db(), token)).toBe(userId);
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
