import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { beforeEach, describe, expect, it } from "vitest";
import { addMembership } from "../db/orgs.js";
import {
	BASE,
	lesson,
	push,
	resetLessonCounter,
} from "../test-support/lessons.js";
import {
	call,
	resetOrgTables,
	type SignedUpUser,
	signup,
} from "../test-support/orgs.js";
import type { WorkerEnv } from "../types";
import { handlePushLessons } from "./lessons.js";

/**
 * The milestone's done-when, end to end, through nothing but routes.
 *
 * Every other org suite seeds its subject with `createLessonsWithFeed`,
 * because until this change the push gate refused the tier outright and there
 * was no way to get an org lesson in through the front door. That left the
 * read path well covered and the CHAIN unproven: a machine pushes a lesson it
 * marked `org`, and the author's colleague - a different account - reads it.
 * That chain is the tier, so nothing here writes to the pool directly.
 */

const db = () => env.DB;

/** One verdict from the push route. */
interface PushResult {
	id: string;
	outcome: string;
	error?: string;
}

let ada: SignedUpUser;
let bo: SignedUpUser;
/**
 * Outside Acme, and inside an org of their own.
 *
 * The second half is what makes the outsider case provable. The predicate
 * only adds its org disjunct for a reader who is in at least one org (see
 * `bounded.length > 0` in db/pool.ts), so a reader in NO org is refused
 * Acme's lesson for a reason that has nothing to do with org scoping - they
 * fail "public OR mine" and the org branch is never built. Ablating
 * `org_id IN (...)` cannot make such a reader see anything, which would make
 * this case unfalsifiable. A reader who holds Globex exercises the disjunct
 * itself: the lesson IS `visibility = 'org'`, and only the org_id comparison
 * keeps it from them.
 */
let outsider: SignedUpUser;
/** In no org at all - the state every account is in before it joins one. */
let loner: SignedUpUser;
let orgId: string;

/** Ada's and Bo's machines, both bound to the same org. */
let adaOrgToken: string;
let boOrgMachine: MintedToken;
/** Ada's other machine. Same account, same org membership, no org on the token. */
let adaPrivateOnlyToken: string;

/**
 * One machine, named by the two things a test needs it for.
 *
 * `id` is what DELETE /api/machines/:id takes, which is how a test ends a
 * token's authority; `token` is what push takes.
 */
interface MintedToken {
	id: string;
	token: string;
}

/**
 * Mint a machine token through POST /api/machines.
 *
 * `org_id` is omitted rather than sent as null for the private-only token, so
 * the fixture exercises the shape every token in production has today.
 */
async function mintToken(
	session: string,
	name: string,
	boundTo: string | null,
): Promise<MintedToken> {
	const response = await call("/api/machines", session, {
		method: "POST",
		body: JSON.stringify(
			boundTo === null ? { name } : { name, org_id: boundTo },
		),
	});

	if (!response.ok) {
		throw new Error(
			`mintToken(${name}) failed: ${response.status} ${await response.text()}`,
		);
	}

	return (await response.json()) as MintedToken;
}

/** Create an org through POST /api/orgs; return its id. */
async function createOrg(session: string, name: string): Promise<string> {
	const response = await call("/api/orgs", session, {
		method: "POST",
		body: JSON.stringify({ name }),
	});

	if (!response.ok) {
		throw new Error(
			`createOrg(${name}) failed: ${response.status} ${await response.text()}`,
		);
	}

	return ((await response.json()) as { org: { id: string } }).org.id;
}

/** Every verdict for one pushed batch. */
async function pushResults(
	token: string,
	lessons: unknown[],
): Promise<PushResult[]> {
	const response = await push(token, lessons);
	return ((await response.json()) as { results: PushResult[] }).results;
}

/** {@link pushResults} for the one-lesson batches, which is most of them. */
async function pushOne(token: string, written: unknown): Promise<PushResult> {
	return (await pushResults(token, [written]))[0];
}

/** The lesson ids GET /api/lessons serves this session. */
async function browse(session: string): Promise<string[]> {
	const response = await call("/api/lessons", session);
	const body = (await response.json()) as { lessons: { id: string }[] };
	return body.lessons.map((entry) => entry.id);
}

beforeEach(async () => {
	// resetOrgTables deliberately leaves the lesson tables alone - see its doc
	// comment - so this suite clears them itself, the way every sibling that
	// touches a lesson does.
	await db().prepare("DELETE FROM lesson_author_blocks").run();
	await db().prepare("DELETE FROM lesson_feed").run();
	await db().prepare("DELETE FROM lessons").run();
	await resetOrgTables();
	resetLessonCounter();

	ada = await signup("ada@example.com", "Ada");
	bo = await signup("bo@example.com", "Bo");
	outsider = await signup("outsider@example.com", "Outsider");
	loner = await signup("loner@example.com", "Loner");

	orgId = await createOrg(ada.token, "Acme");
	// The outsider's own org. Never shares a member or a lesson with Acme; it
	// exists only so the outsider reads as a member of SOMETHING.
	await createOrg(outsider.token, "Globex");

	// Bo joins through the db helper, the same way orgs-lessons.test.ts seeds
	// its member. The accept route cannot do it here: POST /api/orgs/:id/invites
	// deliberately returns no raw token - it goes in the email and nowhere else
	// - so there is no route-only path from "invited" to "member".
	await addMembership(db(), orgId, bo.id, "member");

	adaOrgToken = (await mintToken(ada.token, "ada-laptop", orgId)).token;
	boOrgMachine = await mintToken(bo.token, "bo-laptop", orgId);
	adaPrivateOnlyToken = (await mintToken(ada.token, "ada-desktop", null)).token;
});

describe("the org lesson tier, end to end", () => {
	it("lets two accounts in one org read each other's org lessons", async () => {
		const fromAda = lesson({ visibility: "org" });
		const fromBo = lesson({ visibility: "org" });

		expect((await pushOne(adaOrgToken, fromAda)).outcome).toBe("created");
		expect((await pushOne(boOrgMachine.token, fromBo)).outcome).toBe("created");

		const adaSees = await browse(ada.token);
		const boSees = await browse(bo.token);

		expect(adaSees).toHaveLength(2);
		expect(boSees).toHaveLength(2);
		// Named rather than counted. Two rows each would also be the count if
		// every reader saw only their own lesson twice, and "read each other's"
		// is the property this case exists for.
		expect(adaSees).toContain(fromBo.id);
		expect(boSees).toContain(fromAda.id);
	});

	// Proven by ablation: replacing the org disjunct in db/pool.ts with a bare
	// `visibility = 'org'` makes this case return Acme's lesson and fail.
	it("shows an account outside the org none of them", async () => {
		await pushOne(adaOrgToken, lesson({ visibility: "org" }));

		expect(await browse(outsider.token)).toEqual([]);
	});

	// The other side of `bounded.length > 0`: a reader in no org never has an
	// org disjunct built for them at all, so they are refused by "public OR
	// mine". A different code path from the case above, and the state every
	// account is in until it joins something.
	it("shows an account in no org at all none of them either", async () => {
		await pushOne(adaOrgToken, lesson({ visibility: "org" }));

		expect(await browse(loner.token)).toEqual([]);
	});

	it("refuses an org push from a token bound to no org, naming the token", async () => {
		const written = lesson({ visibility: "org" });

		const result = await pushOne(adaPrivateOnlyToken, written);

		expect(result.outcome).toBe("invalid");
		// The author's mistake is WHICH CREDENTIAL they used. An error about
		// the lesson would send them to the wrong place - this lesson is
		// well-formed, and Ada really is in an org; this token is not.
		expect(result.error).toMatch(/token/i);
		expect(result.error).not.toMatch(/visibility|tier/i);
	});

	it("still lands the private lessons in a batch whose org lesson is refused", async () => {
		// Per-lesson outcomes, not a rejected request: a batch is not all or
		// nothing anywhere else in push and must not become so here.
		const priv = lesson({ visibility: "private" });
		const shared = lesson({ visibility: "org" });

		const results = await pushResults(adaPrivateOnlyToken, [priv, shared]);

		expect(results[0].outcome).toBe("created");
		expect(results[1].outcome).toBe("invalid");
	});

	// The cost of the design, asserted rather than asserted-about. Push is the
	// hottest machine route and `Principal` carries no org, so the handler
	// resolves the token's org only for a batch that mentions one. Both halves
	// run through the SAME harness with the SAME token and the same account -
	// only the lesson's visibility differs - so the second half is what proves
	// the first is measuring anything at all. Without that pairing, a probe
	// that had quietly stopped observing would pass the first half.
	//
	// SCOPE, because the name alone could be read as more than it proves: this
	// measures what THE HANDLER adds, not what the request costs in total. The
	// handler is called directly, off the router, and that is the only way the
	// measurement works - resolvePrincipal verifies the machine token for
	// every `auth: "machine"` route, so over HTTP both halves would touch
	// machine_tokens and the handler's own extra read would be invisible
	// against it. A real private push over HTTP therefore still verifies once,
	// in the router. What this pins is that the handler adds no second read to
	// it.
	it("adds no credential read of its own unless the batch mentions an org", async () => {
		const seen: string[] = [];
		const probed = {
			...(env as unknown as WorkerEnv),
			DB: new Proxy(env.DB, {
				get(target, property, receiver) {
					if (property === "prepare") {
						return (query: string) => {
							seen.push(query);
							return target.prepare(query);
						};
					}
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}) as unknown as D1Database,
		};

		const pushDirectly = (written: unknown) =>
			handlePushLessons(
				new Request(`${BASE}/lessons`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${adaOrgToken}`,
					},
					body: JSON.stringify({ lessons: [written] }),
				}),
				probed,
				{},
				{ userId: ada.id },
			);

		await pushDirectly(lesson({ visibility: "private" }));
		const afterPrivate = seen.filter((query) =>
			query.includes("machine_tokens"),
		);

		await pushDirectly(lesson({ visibility: "org" }));
		const afterOrg = seen.filter((query) => query.includes("machine_tokens"));

		expect(afterPrivate).toEqual([]);
		expect(afterOrg.length).toBeGreaterThan(0);
	});

	// An error must not depend on what else was in the batch.
	//
	// `wantsOrg` asks what the batch CONTAINS, which is a question about what
	// each candidate parses as - not about whether it survived screening. Those
	// came apart once: deriving it from pass 1's admissions meant an org lesson
	// that tripped any check sitting after the org gate was never counted, the
	// org was never resolved, and pass 2 then blamed the credential for a token
	// that was bound perfectly well. Alone in a batch it got the wrong error;
	// beside one valid org lesson it got the right one, because the sibling
	// resolved the org on its behalf.
	//
	// "Alone" is therefore the whole point of the first half, and the equality
	// in the second is the invariant: same lesson, same verdict, whatever it
	// travels with.
	it("blames the lesson, not the credential, for an invalid org lesson alone in a batch", async () => {
		const broken = () =>
			lesson({
				visibility: "org",
				superseded_by: "01KZ45MKAM734ZS7JK24D2DK99",
			});

		const alone = await pushOne(adaOrgToken, broken());
		const beside = await pushResults(adaOrgToken, [
			lesson({ visibility: "org" }),
			broken(),
		]);

		expect(alone.outcome).toBe("invalid");
		expect(alone.error).toMatch(/superseded_by/);
		expect(alone.error).not.toMatch(/token/i);
		expect(beside[1].error).toBe(alone.error);
	});

	// Why can a removed member still push to the org? Because a token is bound
	// to its org once, at minting, after a membership check, and nothing ever
	// re-checks: `verifyMachineToken` reads `machine_tokens.org_id` and that is
	// the whole of it. Removing the member deletes an `org_memberships` row and
	// touches no credential. REVOKING THE TOKEN is the action that ends the
	// sharing.
	//
	// That is D3, not an oversight. The server reads the org from the
	// credential and never from the request, which is what stops a client
	// naming an org its holder does not belong to. Note the asymmetry this
	// produces, asserted below: reading stops at once, because the read
	// predicate resolves the reader's CURRENT memberships on every query,
	// while writing continues, because the write reads a credential that was
	// authorized when it was issued.
	//
	// MAKING THIS CASE FAIL BY CHECKING MEMBERSHIP AT PUSH TIME WOULD BE A
	// DESIGN CHANGE, NOT A BUG FIX. It would move the authority from the
	// credential back to request time and put an `org_memberships` read on the
	// hottest machine route - the very cost the conditional resolve above
	// exists to avoid. If this behavior is ever unwanted, the fix is revoking
	// tokens when a membership ends, not consulting memberships on every push.
	it("lets a removed member keep pushing until their token is revoked", async () => {
		const fromAda = lesson({ visibility: "org" });
		await pushOne(adaOrgToken, fromAda);
		expect(await browse(bo.token)).toContain(fromAda.id);

		const removal = await call(
			`/api/orgs/${orgId}/members/${bo.id}`,
			ada.token,
			{ method: "DELETE" },
		);
		expect(removal.status).toBe(200);

		// Reading stops immediately - Acme is no longer among Bo's orgs, so the
		// predicate stops counting it.
		expect(await browse(bo.token)).not.toContain(fromAda.id);

		// Writing does not. The token still carries the org, and the lesson
		// still reaches the org it names: Ada, who is still a member, reads it.
		const afterRemoval = lesson({ visibility: "org" });
		expect((await pushOne(boOrgMachine.token, afterRemoval)).outcome).toBe(
			"created",
		);
		expect(await browse(ada.token)).toContain(afterRemoval.id);

		// Revoking the credential is what actually ends it. A revoked token
		// gets no per-lesson verdict at all - it never reaches the handler,
		// because the router rejects it.
		const revocation = await call(
			`/api/machines/${boOrgMachine.id}`,
			bo.token,
			{ method: "DELETE" },
		);
		expect(revocation.status).toBe(200);

		const blocked = await push(boOrgMachine.token, [
			lesson({ visibility: "org" }),
		]);
		expect(blocked.status).toBe(401);
	});

	// The risk this change introduces at the route rather than the db layer.
	// `tokenOrgId` is now handed to the write for the WHOLE batch, so the
	// stamping rule - org_id on `org` rows only - is what keeps a private
	// lesson pushed with an org-bound token out of the org's reach. Pushed by
	// the one account in the org that has a colleague who would see it.
	it("keeps a private lesson private even when the token is bound to an org", async () => {
		const priv = lesson({ visibility: "private" });

		expect((await pushOne(adaOrgToken, priv)).outcome).toBe("created");

		expect(await browse(ada.token)).toContain(priv.id);
		expect(await browse(bo.token)).toEqual([]);
	});
});
