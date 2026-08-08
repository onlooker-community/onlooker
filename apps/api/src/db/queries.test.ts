import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createUser,
	getRefreshToken,
	getUserByEmail,
	getUserById,
	revokeRefreshToken,
	storeRefreshToken,
} from "./queries.js";

// These pin the CONTRACT of each function - what callers observe - not the
// storage representation. Task 3 changes how email_verified is stored, so its
// assertion is deliberately about the semantic ("not yet verified"), never the
// literal column value. A test asserting the literal would have to be edited
// in Task 3, and an edited test pins nothing.

const db = () => env.DB;

beforeEach(async () => {
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
});

describe("createUser", () => {
	it("returns the id, email and name of the created user", async () => {
		const result = await createUser(db(), "a@example.com", "hash", "Ada");

		expect(result.email).toBe("a@example.com");
		expect(result.name).toBe("Ada");
		expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("persists the user so it can be found by email", async () => {
		await createUser(db(), "b@example.com", "hash", "Grace");
		const found = await getUserByEmail(db(), "b@example.com");

		expect(found?.email).toBe("b@example.com");
		expect(found?.password_hash).toBe("hash");
	});

	it("creates the user as not yet verified", async () => {
		await createUser(db(), "c@example.com", "hash");
		const found = await getUserByEmail(db(), "c@example.com");

		// Semantic, not literal: false today, null after Task 3.
		expect(Boolean(found?.email_verified)).toBe(false);
	});

	it("accepts a user with no name", async () => {
		const result = await createUser(db(), "d@example.com", "hash");
		expect(result.email).toBe("d@example.com");
	});
});

describe("getUserByEmail", () => {
	it("returns null when no user has that email", async () => {
		expect(await getUserByEmail(db(), "nobody@example.com")).toBeNull();
	});
});

describe("getUserById", () => {
	it("finds a user by id and omits the password hash", async () => {
		const created = await createUser(db(), "e@example.com", "hash", "Alan");
		const found = await getUserById(db(), created.id);

		expect(found?.email).toBe("e@example.com");
		expect(found).not.toHaveProperty("password_hash");
	});

	it("returns null for an unknown id", async () => {
		expect(await getUserById(db(), "no-such-id")).toBeNull();
	});
});

describe("refresh tokens", () => {
	const future = () => new Date(Date.now() + 60_000);
	const past = () => new Date(Date.now() - 60_000);

	it("stores a token and retrieves it by its raw value", async () => {
		const user = await createUser(db(), "f@example.com", "hash");
		await storeRefreshToken(db(), user.id, "raw-token", future());

		const found = await getRefreshToken(db(), "raw-token");
		expect(found?.user_id).toBe(user.id);
	});

	it("does not store the raw token, only a hash", async () => {
		const user = await createUser(db(), "g@example.com", "hash");
		await storeRefreshToken(db(), user.id, "raw-token", future());

		const row = await db()
			.prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
			.bind(user.id)
			.first<{ token_hash: string }>();

		expect(row?.token_hash).not.toBe("raw-token");
		expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("returns null for a token that was never stored", async () => {
		expect(await getRefreshToken(db(), "never-stored")).toBeNull();
	});

	it("returns null for an expired token even though the row exists", async () => {
		const user = await createUser(db(), "h@example.com", "hash");
		await storeRefreshToken(db(), user.id, "stale-token", past());

		expect(await getRefreshToken(db(), "stale-token")).toBeNull();

		const row = await db()
			.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
			.bind(user.id)
			.first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it("stops returning a token once it is revoked", async () => {
		const user = await createUser(db(), "i@example.com", "hash");
		await storeRefreshToken(db(), user.id, "doomed-token", future());
		expect(await getRefreshToken(db(), "doomed-token")).not.toBeNull();

		await revokeRefreshToken(db(), "doomed-token");
		expect(await getRefreshToken(db(), "doomed-token")).toBeNull();
	});

	it("revoking a token that does not exist does not throw", async () => {
		await expect(
			revokeRefreshToken(db(), "not-a-real-token"),
		).resolves.toBeUndefined();
	});

	// Every other revoke test checks only the token it just revoked, so all of
	// them would still pass if revokeRefreshToken lost its where clause and
	// deleted the whole sessions table. This is the one that would catch it -
	// the scope of the delete, not just its effect on the target.
	it("revoking one token leaves another user's session intact", async () => {
		const alice = await createUser(db(), "alice@example.com", "hash");
		const bob = await createUser(db(), "bob@example.com", "hash");
		await storeRefreshToken(db(), alice.id, "alice-token", future());
		await storeRefreshToken(db(), bob.id, "bob-token", future());

		await revokeRefreshToken(db(), "alice-token");

		expect(await getRefreshToken(db(), "alice-token")).toBeNull();
		expect(await getRefreshToken(db(), "bob-token")).not.toBeNull();
	});
});
