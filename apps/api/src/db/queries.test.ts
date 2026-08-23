import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	consumeVerificationToken,
	createUser,
	createVerificationToken,
	deleteUser,
	deleteVerificationTokens,
	getPasswordHash,
	getRefreshToken,
	getUserByEmail,
	getUserById,
	isEmailVerified,
	revokeAllSessionsForUser,
	revokeAllSessionsForUserExcept,
	revokeRefreshToken,
	rotateRefreshToken,
	setEmailVerified,
	storeRefreshToken,
	updatePassword,
	updateProfile,
	verificationTokenTarget,
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

	// A rotation is one operation, not a revoke that happens to be followed by a
	// store. Split into two awaits, a failure between them takes the caller's
	// refresh token away without issuing a replacement - a forced logout with
	// nothing to retry and no error the client can act on.
	//
	// Forced here through the unique index on token_hash: rotating TO a value
	// another session already holds makes the insert fail while the delete would
	// otherwise have succeeded. Two awaits leave the old session deleted. One
	// batch rolls both back.
	describe("rotateRefreshToken", () => {
		it("revokes the old token and stores the new one", async () => {
			const user = await createUser(db(), "rot@example.com", "hash");
			await storeRefreshToken(db(), user.id, "old-token", future());

			await rotateRefreshToken(
				db(),
				"old-token",
				user.id,
				"new-token",
				future(),
			);

			expect(await getRefreshToken(db(), "old-token")).toBeNull();
			expect((await getRefreshToken(db(), "new-token"))?.user_id).toBe(user.id);
		});

		it("leaves the old token usable when storing the new one fails", async () => {
			const user = await createUser(db(), "atomic@example.com", "hash");
			await storeRefreshToken(db(), user.id, "old-token", future());
			// Held by a different session, so rotating onto it violates the unique
			// index on token_hash.
			await storeRefreshToken(db(), user.id, "taken-token", future());

			await expect(
				rotateRefreshToken(db(), "old-token", user.id, "taken-token", future()),
			).rejects.toThrow();

			// The half that would have succeeded on its own must not have landed.
			// This is the assertion that fails if the batch is ever unpicked back
			// into a revoke and a store.
			expect((await getRefreshToken(db(), "old-token"))?.user_id).toBe(user.id);
		});
	});

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

// Everything below backs the account endpoints, which were nine 501 stubs. Same
// rule as above: these pin what a caller observes, not how a column stores it.

describe("updateProfile", () => {
	it("changes the name and leaves everything else alone", async () => {
		const { id } = await createUser(db(), "p1@example.com", "hash", "Ada");

		await updateProfile(db(), id, { name: "Ada Lovelace" });
		const user = await getUserById(db(), id);

		expect(user?.name).toBe("Ada Lovelace");
		expect(user?.email).toBe("p1@example.com");
	});

	it("changes the email", async () => {
		const { id } = await createUser(db(), "p2@example.com", "hash");

		await updateProfile(db(), id, { email: "moved@example.com" });

		expect((await getUserById(db(), id))?.email).toBe("moved@example.com");
	});

	// An update with nothing in it is a no-op, not an error and not a wipe. The
	// handler already rejects malformed input; this guards the case where a
	// caller sends {} and a naive implementation would null both columns.
	it("leaves the row untouched when given nothing to change", async () => {
		const { id } = await createUser(db(), "p3@example.com", "hash", "Grace");

		await updateProfile(db(), id, {});
		const user = await getUserById(db(), id);

		expect(user?.name).toBe("Grace");
		expect(user?.email).toBe("p3@example.com");
	});

	it("moves updated_at forward", async () => {
		const { id } = await createUser(db(), "p4@example.com", "hash");
		const before = (await getUserById(db(), id))?.updated_at as string;

		await updateProfile(db(), id, { name: "Later" });
		const after = (await getUserById(db(), id))?.updated_at as string;

		expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
			new Date(before).getTime(),
		);
	});
});

describe("setEmailVerified", () => {
	it("starts unverified", async () => {
		const { id } = await createUser(db(), "v1@example.com", "hash");

		expect(await isEmailVerified(db(), id)).toBe(false);
	});

	it("marks verified, and back again", async () => {
		const { id } = await createUser(db(), "v2@example.com", "hash");

		await setEmailVerified(db(), id, true);
		expect(await isEmailVerified(db(), id)).toBe(true);

		// Changing an address has to undo this, which is the only reason the
		// false direction exists.
		await setEmailVerified(db(), id, false);
		expect(await isEmailVerified(db(), id)).toBe(false);
	});
});

describe("updatePassword", () => {
	it("replaces the stored hash", async () => {
		const { id } = await createUser(db(), "w1@example.com", "old-hash");

		await updatePassword(db(), id, "new-hash");

		expect((await getUserByEmail(db(), "w1@example.com"))?.password_hash).toBe(
			"new-hash",
		);
	});

	it("touches only the user it was given", async () => {
		const { id } = await createUser(db(), "w2@example.com", "mine");
		await createUser(db(), "w3@example.com", "theirs");

		await updatePassword(db(), id, "changed");

		expect((await getUserByEmail(db(), "w3@example.com"))?.password_hash).toBe(
			"theirs",
		);
	});
});

describe("revokeAllSessionsForUser", () => {
	it("removes every session that user holds", async () => {
		const { id } = await createUser(db(), "s1@example.com", "hash");
		const future = new Date(Date.now() + 86_400_000);
		await storeRefreshToken(db(), id, "laptop", future);
		await storeRefreshToken(db(), id, "phone", future);

		await revokeAllSessionsForUser(db(), id);

		expect(await getRefreshToken(db(), "laptop")).toBeNull();
		expect(await getRefreshToken(db(), "phone")).toBeNull();
	});

	// Without a where clause this would sign out the entire product, and every
	// assertion above would still pass.
	it("leaves other users signed in", async () => {
		const mine = await createUser(db(), "s2@example.com", "hash");
		const theirs = await createUser(db(), "s3@example.com", "hash");
		const future = new Date(Date.now() + 86_400_000);
		await storeRefreshToken(db(), mine.id, "mine", future);
		await storeRefreshToken(db(), theirs.id, "theirs", future);

		await revokeAllSessionsForUser(db(), mine.id);

		expect(await getRefreshToken(db(), "theirs")).not.toBeNull();
	});
});

describe("deleteUser", () => {
	it("removes the user", async () => {
		const { id } = await createUser(db(), "d1@example.com", "hash");

		await deleteUser(db(), id);

		expect(await getUserById(db(), id)).toBeNull();
		expect(await getUserByEmail(db(), "d1@example.com")).toBeNull();
	});

	// The schema cascades sessions from users. Asserted because it is the whole
	// reason deletion does not need to sweep them itself - if the foreign key
	// ever loses ON DELETE CASCADE, a deleted account keeps working sessions.
	it("takes the user's sessions with it", async () => {
		const { id } = await createUser(db(), "d2@example.com", "hash");
		await storeRefreshToken(
			db(),
			id,
			"doomed",
			new Date(Date.now() + 86_400_000),
		);

		await deleteUser(db(), id);

		expect(await getRefreshToken(db(), "doomed")).toBeNull();
	});

	it("frees the email address for reuse", async () => {
		const { id } = await createUser(db(), "d3@example.com", "hash");
		await deleteUser(db(), id);

		const replacement = await createUser(db(), "d3@example.com", "hash2");

		expect(replacement.id).not.toBe(id);
	});
});

describe("getPasswordHash", () => {
	// By id, not by email. The access token carries an email claim that goes
	// stale the moment someone edits their address, and change-password is
	// reachable with such a token - looking the user up by that claim would
	// 404 exactly the person who just changed their email.
	it("returns the hash for a user id", async () => {
		const { id } = await createUser(db(), "h1@example.com", "secret-hash");

		expect(await getPasswordHash(db(), id)).toBe("secret-hash");
	});

	it("returns null for an unknown id", async () => {
		expect(await getPasswordHash(db(), crypto.randomUUID())).toBeNull();
	});

	it("still finds the user after their email changes", async () => {
		const { id } = await createUser(db(), "h2@example.com", "kept");
		await updateProfile(db(), id, { email: "h2-new@example.com" });

		expect(await getPasswordHash(db(), id)).toBe("kept");
	});
});

describe("revokeAllSessionsForUserExcept", () => {
	it("ends the other sessions and spares the one named", async () => {
		const { id } = await createUser(db(), "k1@example.com", "hash");
		const future = new Date(Date.now() + 86_400_000);
		await storeRefreshToken(db(), id, "this-device", future);
		await storeRefreshToken(db(), id, "other-device", future);

		await revokeAllSessionsForUserExcept(db(), id, "this-device");

		expect(await getRefreshToken(db(), "this-device")).not.toBeNull();
		expect(await getRefreshToken(db(), "other-device")).toBeNull();
	});

	it("leaves other users alone", async () => {
		const mine = await createUser(db(), "k2@example.com", "hash");
		const theirs = await createUser(db(), "k3@example.com", "hash");
		const future = new Date(Date.now() + 86_400_000);
		await storeRefreshToken(db(), mine.id, "mine", future);
		await storeRefreshToken(db(), theirs.id, "theirs", future);

		await revokeAllSessionsForUserExcept(db(), mine.id, "mine");

		expect(await getRefreshToken(db(), "theirs")).not.toBeNull();
	});

	// A caller that sends no token to spare wants everything gone, and must not
	// accidentally get "spare the session whose token is undefined".
	it("ends everything when nothing is spared", async () => {
		const { id } = await createUser(db(), "k4@example.com", "hash");
		await storeRefreshToken(
			db(),
			id,
			"only",
			new Date(Date.now() + 86_400_000),
		);

		await revokeAllSessionsForUserExcept(db(), id, undefined);

		expect(await getRefreshToken(db(), "only")).toBeNull();
	});
});

// Verification and reset tokens. Both flows share one table with a `type`
// discriminator, so most of these exist to prove the two cannot be confused for
// one another - a verification token that works as a password reset is an
// account takeover, not a bug report.

describe("verification tokens", () => {
	const soon = () => new Date(Date.now() + 3_600_000);

	it("issues a token that can be consumed once", async () => {
		const { id } = await createUser(db(), "t1@example.com", "hash");

		const token = await createVerificationToken(db(), id, "verify", soon());
		expect(token).toEqual(expect.any(String));

		expect(await consumeVerificationToken(db(), token, "verify")).toBe(id);
		// Single use. The second attempt is a replay, whoever is making it.
		expect(await consumeVerificationToken(db(), token, "verify")).toBeNull();
	});

	// The raw token must not be recoverable from the table. Stored plaintext, a
	// read of this table is a working reset link for every pending request.
	it("stores only a hash, never the token", async () => {
		const { id } = await createUser(db(), "t2@example.com", "hash");
		const token = await createVerificationToken(db(), id, "reset", soon());

		const { results } = await db()
			.prepare("SELECT * FROM verification_tokens")
			.all();

		expect(JSON.stringify(results)).not.toContain(token);
	});

	it("refuses a token of the wrong type", async () => {
		const { id } = await createUser(db(), "t3@example.com", "hash");
		const verify = await createVerificationToken(db(), id, "verify", soon());

		// A verification link must not double as a password reset.
		expect(await consumeVerificationToken(db(), verify, "reset")).toBeNull();
		// And it still works as what it is - the failed attempt consumed nothing.
		expect(await consumeVerificationToken(db(), verify, "verify")).toBe(id);
	});

	it("refuses an expired token", async () => {
		const { id } = await createUser(db(), "t4@example.com", "hash");
		const expired = await createVerificationToken(
			db(),
			id,
			"reset",
			new Date(Date.now() - 1_000),
		);

		expect(await consumeVerificationToken(db(), expired, "reset")).toBeNull();
	});

	it("refuses a token nobody issued", async () => {
		expect(
			await consumeVerificationToken(db(), "invented", "reset"),
		).toBeNull();
	});

	// Requesting a new link should retire the old one, or every reset email ever
	// sent stays live until it expires.
	it("drops a user's earlier tokens of the same type", async () => {
		const { id } = await createUser(db(), "t5@example.com", "hash");
		const first = await createVerificationToken(db(), id, "reset", soon());

		await deleteVerificationTokens(db(), id, "reset");
		const second = await createVerificationToken(db(), id, "reset", soon());

		expect(await consumeVerificationToken(db(), first, "reset")).toBeNull();
		expect(await consumeVerificationToken(db(), second, "reset")).toBe(id);
	});

	it("leaves the other flow's tokens alone when clearing one", async () => {
		const { id } = await createUser(db(), "t6@example.com", "hash");
		const verify = await createVerificationToken(db(), id, "verify", soon());

		await deleteVerificationTokens(db(), id, "reset");

		expect(await consumeVerificationToken(db(), verify, "verify")).toBe(id);
	});

	it("goes with the user when the account is deleted", async () => {
		const { id } = await createUser(db(), "t7@example.com", "hash");
		const token = await createVerificationToken(db(), id, "verify", soon());

		await deleteUser(db(), id);

		expect(await consumeVerificationToken(db(), token, "verify")).toBeNull();
	});

	it("issues a different token every time", async () => {
		const { id } = await createUser(db(), "t8@example.com", "hash");

		const a = await createVerificationToken(db(), id, "reset", soon());
		const b = await createVerificationToken(db(), id, "reset", soon());

		expect(a).not.toBe(b);
	});
});

// Checking a reset link before showing the form is a read, not a spend. The
// user has not chosen a new password yet, and burning the token here would mean
// opening the page consumed the only link they were sent.
describe("verificationTokenTarget", () => {
	const soon = () => new Date(Date.now() + 3_600_000);

	it("reports the address a valid token belongs to, without spending it", async () => {
		const { id } = await createUser(db(), "pk1@example.com", "hash");
		const token = await createVerificationToken(db(), id, "reset", soon());

		expect(await verificationTokenTarget(db(), token, "reset")).toEqual({
			userId: id,
			email: "pk1@example.com",
		});
		// Still spendable, which is the whole point.
		expect(await consumeVerificationToken(db(), token, "reset")).toBe(id);
	});

	it("reports nothing for an expired token", async () => {
		const { id } = await createUser(db(), "pk2@example.com", "hash");
		const token = await createVerificationToken(
			db(),
			id,
			"reset",
			new Date(Date.now() - 1_000),
		);

		expect(await verificationTokenTarget(db(), token, "reset")).toBeNull();
	});

	it("reports nothing for the wrong flow", async () => {
		const { id } = await createUser(db(), "pk3@example.com", "hash");
		const verify = await createVerificationToken(db(), id, "verify", soon());

		expect(await verificationTokenTarget(db(), verify, "reset")).toBeNull();
	});

	it("reports nothing for a token nobody issued", async () => {
		expect(await verificationTokenTarget(db(), "invented", "reset")).toBeNull();
	});
});
