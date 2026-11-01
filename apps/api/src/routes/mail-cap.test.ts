import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DAILY_MAIL_CEILINGS,
	globalMailKey,
	type MailKind,
} from "../db/mail-sends.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";

// The counting is pinned in db/mail-sends.test.ts and the reporting in
// email/cap.test.ts. These cover what each caller gets, and above all that a
// refused request leaves the link already sent working - the reason the claim
// runs before the token work rather than inside sendEmail (ONL-222).

const db = () => env.DB;
const ADA = "ada@example.com";

interface ErrorBody {
	success: false;
	error: { code: string; message: string };
}

beforeEach(async () => {
	await db().prepare("DELETE FROM verification_tokens").run();
	await resetOrgTables();
});

const post = (path: string, body: unknown, token: string | null = null) =>
	call(path, token, { method: "POST", body: JSON.stringify(body) });

const tokenHashes = async (userId: string, type: "reset" | "verify") =>
	(
		await db()
			.prepare(
				"SELECT token_hash FROM verification_tokens WHERE user_id = ? AND type = ?",
			)
			.bind(userId, type)
			.all<{ token_hash: string }>()
	).results.map((row) => row.token_hash);

const spendThePool = (kind: MailKind) =>
	db()
		.prepare(
			"INSERT INTO mail_sends (key, window_start, count) VALUES (?, ?, ?)",
		)
		.bind(
			globalMailKey(kind, new Date()),
			new Date().toISOString(),
			DAILY_MAIL_CEILINGS[kind],
		)
		.run();

describe("POST /auth/forgot-password under the cap", () => {
	let ada: SignedUpUser;
	beforeEach(async () => {
		ada = await signup(ADA);
	});

	// Any difference would say "this address was mailed recently", which means
	// it has an account - the thing handleForgotPassword exists not to say.
	it("answers the fourth request in an hour exactly as it answered the first", async () => {
		const first = await post("/auth/forgot-password", { email: ADA });
		const firstText = await first.text();
		await post("/auth/forgot-password", { email: ADA });
		await post("/auth/forgot-password", { email: ADA });

		const fourth = await post("/auth/forgot-password", { email: ADA });

		expect(fourth.status).toBe(first.status);
		expect(await fourth.text()).toBe(firstText);
	});

	// The positive half: without it, the test below could pass because nothing
	// ever replaces a link.
	it("replaces the link on each request under the cap", async () => {
		await post("/auth/forgot-password", { email: ADA });
		const first = await tokenHashes(ada.id, "reset");
		await post("/auth/forgot-password", { email: ADA });

		expect(first).toHaveLength(1);
		expect(await tokenHashes(ada.id, "reset")).not.toEqual(first);
	});

	it("leaves the third request's link working when it refuses the fourth", async () => {
		for (let i = 0; i < 3; i++) {
			await post("/auth/forgot-password", { email: ADA });
		}
		const third = await tokenHashes(ada.id, "reset");

		await post("/auth/forgot-password", { email: ADA });

		expect(third).toHaveLength(1);
		expect(await tokenHashes(ada.id, "reset")).toEqual(third);
	});

	it("writes no counter for an address with no account", async () => {
		await post("/auth/forgot-password", { email: "nobody-here@example.com" });

		const row = await db()
			.prepare("SELECT COUNT(*) AS n FROM mail_sends")
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
	});

	it("sends nothing once the reset pool is spent, and answers exactly as a send", async () => {
		await spendThePool("reset");

		const response = await post("/auth/forgot-password", { email: ADA });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(JSON.stringify({ success: true }));
		expect(await tokenHashes(ada.id, "reset")).toEqual([]);
	});
});

describe("POST /auth/resend-verification under the cap", () => {
	let ada: SignedUpUser;
	beforeEach(async () => {
		ada = await signup(ADA);
	});

	it("refuses the fourth resend in an hour with 429 and a Retry-After", async () => {
		for (let i = 0; i < 3; i++) {
			expect(
				(await post("/auth/resend-verification", {}, ada.token)).status,
			).toBe(200);
		}

		const refused = await post("/auth/resend-verification", {}, ada.token);

		expect(refused.status).toBe(429);
		expect(((await refused.json()) as ErrorBody).error.code).toBe(
			"rate_limit_exceeded",
		);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	it("leaves the outstanding verification link alone when it refuses", async () => {
		for (let i = 0; i < 3; i++) {
			await post("/auth/resend-verification", {}, ada.token);
		}
		const third = await tokenHashes(ada.id, "verify");

		await post("/auth/resend-verification", {}, ada.token);

		expect(third).toHaveLength(1);
		expect(await tokenHashes(ada.id, "verify")).toEqual(third);
	});
});

describe("POST /api/orgs/:id/invites under the cap", () => {
	let ada: SignedUpUser;
	let orgId: string;

	const createOrg = async (name: string) => {
		const created = await post("/api/orgs", { name }, ada.token);
		return ((await created.json()) as { org: { id: string } }).org.id;
	};
	const invite = (org: string, email: string) =>
		post(`/api/orgs/${org}/invites`, { email, role: "member" }, ada.token);
	const inviteHash = async (email: string) =>
		(
			await db()
				.prepare("SELECT token_hash FROM org_invites WHERE email = ?")
				.bind(email)
				.first<{ token_hash: string }>()
		)?.token_hash;

	beforeEach(async () => {
		ada = await signup(ADA);
		orgId = await createOrg("Acme");
	});

	it("refuses a fourth invite to one address in a day, and leaves the third intact", async () => {
		for (let i = 0; i < 3; i++) {
			expect((await invite(orgId, "new@example.com")).status).toBe(201);
		}
		const third = await inviteHash("new@example.com");

		const refused = await invite(orgId, "new@example.com");

		expect(refused.status).toBe(429);
		expect(((await refused.json()) as ErrorBody).error.code).toBe(
			"rate_limit_exceeded",
		);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(third).toBeDefined();
		expect(await inviteHash("new@example.com")).toBe(third);
	});

	// The route that can mail a stranger. Anyone can make an org, so a cap per
	// org would be a cap per attacker's patience.
	it("counts invites to one address across orgs", async () => {
		const other = await createOrg("Other");
		await invite(orgId, "new@example.com");
		await invite(orgId, "new@example.com");
		await invite(other, "new@example.com");

		expect((await invite(other, "new@example.com")).status).toBe(429);
	});

	it("refuses an invite once the invite pool is spent", async () => {
		await spendThePool("invite");

		expect((await invite(orgId, "new@example.com")).status).toBe(429);
	});

	// The claim runs after validation, so an invite that could never be sent
	// spends neither the address's slot nor the day's.
	it.each([
		{ email: "not-an-address", status: 400, code: "invalid_email" },
		{ email: ADA, status: 409, code: "already_member" },
	])("writes no counter for an invite refused as $code", async ({
		email,
		status,
		code,
	}) => {
		const refused = await invite(orgId, email);

		expect(refused.status).toBe(status);
		expect(((await refused.json()) as ErrorBody).error.code).toBe(code);
		const row = await db()
			.prepare("SELECT COUNT(*) AS n FROM mail_sends")
			.first<{ n: number }>();
		expect(row?.n).toBe(0);
	});
});
