import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mirrorDir, readCursor, writeCursor } from "../pool";
import { pull } from "../pull";

const ids = [
	"01KZ45MKAM734ZS7JK24D2DK0R",
	"01KZ45MKAM734ZS7JK24D2DK0S",
	"01KZ45MKAM734ZS7JK24D2DK0T",
];

function env(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-pull-")) };
}

/**
 * A lesson the contract actually accepts, built from the fixture the push
 * tests already use. Invented shapes would pass through ZLesson as invalid and
 * quietly turn every assertion about counts into an assertion about nothing.
 */
const FIXTURE = JSON.parse(
	readFileSync(join(__dirname, "fixtures", "lesson.json"), "utf8"),
);

const lesson = (id: string, claim = FIXTURE.claim) => ({
	...FIXTURE,
	id,
	claim,
});

/**
 * A lesson valid under a contract newer than the one this CLI bundles.
 *
 * The API validates every lesson against ZLesson before it is written, so a
 * row the CLI refuses is one the server's contract accepted. A field this
 * CLI's strict object has never heard of is the shape that takes.
 */
const newer = (id: string) => ({ ...lesson(id), counter_observations: [] });

interface Page {
	lessons: Array<{ seq: number; lesson: unknown }>;
	has_more: boolean;
}

/** A client answering fixed windows in order, then empty ones. */
const windows = (...pages: Page[]) => {
	let call = 0;
	return {
		readDelta: vi.fn().mockImplementation(async () => {
			const page = pages[call++] ?? { lessons: [], has_more: false };
			return {
				lessons: page.lessons,
				cursor: page.lessons.at(-1)?.seq ?? 0,
				has_more: page.has_more,
			};
		}),
	};
};

/**
 * A client answering from a feed the way the API does: rows above `since`, in
 * seq order, `limit` at a time.
 *
 * The retry path asks for one seq by reading the window that starts just
 * below it, so a stub answering fixed pages in call order cannot stand in for
 * the server there.
 */
const feed = (rows: Record<number, unknown>) => ({
	readDelta: vi
		.fn()
		.mockImplementation(async (since: number, limit: number) => {
			const above = Object.keys(rows)
				.map(Number)
				.filter((seq) => seq > since)
				.sort((a, b) => a - b);
			const page = above.slice(0, limit);
			return {
				lessons: page.map((seq) => ({ seq, lesson: rows[seq] })),
				cursor: page.at(-1) ?? since,
				has_more: above.length > limit,
			};
		}),
});

/**
 * Lesson files only, ignoring cursor.json.
 *
 * A missing directory counts as none rather than throwing: a run that refuses
 * its window never creates one, and that is the state these tests assert.
 */
const stored = (e: NodeJS.ProcessEnv) =>
	existsSync(mirrorDir(e))
		? readdirSync(mirrorDir(e)).filter((f) => f !== "cursor.json")
		: [];

describe("pull", () => {
	it("writes what arrives and advances the cursor", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: lesson(ids[0]) },
				{ seq: 2, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 2, cursor: 2 });
		expect(stored(e)).toHaveLength(2);
		expect(readCursor(e).seq).toBe(2);
	});

	it("starts from the stored cursor, not from zero", async () => {
		const e = env();
		writeCursor({ seq: 5, held: [] }, e);
		const client = windows({ lessons: [], has_more: false });

		await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledWith(5, expect.any(Number));
	});

	it("follows has_more across windows", async () => {
		const e = env();
		const client = windows(
			{ lessons: [{ seq: 1, lesson: lesson(ids[0]) }], has_more: true },
			{ lessons: [{ seq: 2, lesson: lesson(ids[1]) }], has_more: false },
		);

		const outcome = await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledTimes(2);
		expect(outcome).toMatchObject({ kind: "received", created: 2, cursor: 2 });
	});

	// THE CENTRAL CLAIM. A window that fails to write must leave the cursor
	// where it was, so the next run re-fetches it. The inverse - advancing
	// first - is ecosystem-449.55 one layer down, where librarian's watermark
	// moves through an outage and the skipped artifacts are never re-scanned.
	// That failure is invisible, because the watermark is the thing claiming
	// everything is fine.
	it("leaves the cursor unmoved when writing a window fails", async () => {
		const e = env();
		writeCursor({ seq: 3, held: [] }, e);
		// The cursor stays readable and every new write fails: the directory
		// is made read-only, so reading cursor.json still works while creating
		// a lesson file does not.
		chmodSync(mirrorDir(e), 0o555);
		const client = windows({
			lessons: [{ seq: 4, lesson: lesson(ids[0]) }],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });
		chmodSync(mirrorDir(e), 0o755);

		expect(outcome.kind).toBe("failed");
		expect(outcome.cursor).toBe(3);
	});

	it("advances per window, so an interrupted run keeps its progress", async () => {
		const e = env();
		let call = 0;
		const client = {
			readDelta: vi.fn().mockImplementation(async () => {
				call += 1;
				if (call === 1) {
					return {
						lessons: [{ seq: 1, lesson: lesson(ids[0]) }],
						cursor: 1,
						has_more: true,
					};
				}
				throw new Error("network died");
			}),
		};

		const outcome = await pull({ client, env: e });

		expect(outcome.kind).toBe("failed");
		// The first window was written, so its progress survives. Without
		// per-window advancement a long first pull could never finish over a
		// flaky link - every attempt would discard everything it fetched.
		expect(readCursor(e).seq).toBe(1);
	});

	// seq is dense - COALESCE(MAX(seq),0)+1 behind a unique index, collisions
	// retried rather than burning a value, and no delete path - so a hole
	// means a row that should exist did not come back.
	it("stops on a gap and does not advance", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: lesson(ids[0]) },
				{ seq: 3, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({
			kind: "gap",
			expected: 2,
			got: 3,
			cursor: 0,
		});
		expect(readCursor(e).seq).toBe(0);
	});

	it("writes nothing from a window that contains a gap", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: lesson(ids[0]) },
				{ seq: 3, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		await pull({ client, env: e });

		// Contiguity is checked before anything is written, so a window is
		// all-or-nothing rather than partially applied under a stale cursor.
		expect(stored(e)).toHaveLength(0);
	});

	it("detects a gap against the stored cursor, not only within a window", async () => {
		const e = env();
		writeCursor({ seq: 10, held: [] }, e);
		const client = windows({
			lessons: [{ seq: 12, lesson: lesson(ids[0]) }],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "gap", expected: 11, got: 12 });
	});

	// Never re-mirror from zero. That would paper over the one anomaly seq
	// exists to expose, and would look like a slow but healthy run.
	it("does not restart from zero after a gap", async () => {
		const e = env();
		writeCursor({ seq: 10, held: [] }, e);
		const client = windows({
			lessons: [{ seq: 12, lesson: lesson(ids[0]) }],
			has_more: false,
		});

		await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledTimes(1);
		expect(client.readDelta).toHaveBeenCalledWith(10, expect.any(Number));
	});

	it("holds a lesson the contract refuses rather than writing it", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: newer(ids[0]) },
				{ seq: 2, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 1 });
		if (outcome.kind !== "received") return;
		expect(outcome.held).toHaveLength(1);
		expect(outcome.held[0]).toMatch(/^seq 1: /);
		// The valid lesson beside it still landed, and the cursor still moved.
		// One row the contract refuses must not wedge the mirror behind it
		// forever - that would be a permanent outage caused by one bad record.
		expect(readCursor(e)).toEqual({ seq: 2, held: [1] });
	});

	it("counts an unchanged re-send as unchanged", async () => {
		const e = env();
		await pull({
			client: windows({
				lessons: [{ seq: 1, lesson: lesson(ids[0]) }],
				has_more: false,
			}),
			env: e,
		});

		writeCursor({ seq: 0, held: [] }, e);
		const outcome = await pull({
			client: windows({
				lessons: [{ seq: 1, lesson: lesson(ids[0]) }],
				has_more: false,
			}),
			env: e,
		});

		expect(outcome).toMatchObject({
			kind: "received",
			created: 0,
			unchanged: 1,
		});
	});

	it("counts a changed lesson as updated", async () => {
		const e = env();
		await pull({
			client: windows({
				lessons: [{ seq: 1, lesson: lesson(ids[0]) }],
				has_more: false,
			}),
			env: e,
		});

		const outcome = await pull({
			client: windows({
				lessons: [
					{ seq: 2, lesson: lesson(ids[0], "Because it was re-measured.") },
				],
				has_more: false,
			}),
			env: e,
		});

		expect(outcome).toMatchObject({ kind: "received", updated: 1 });
		expect(stored(e)).toHaveLength(1);
	});

	it("is a no-op when nothing is waiting", async () => {
		const e = env();
		writeCursor({ seq: 4, held: [] }, e);
		const client = windows({ lessons: [], has_more: false });

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 0, cursor: 4 });
	});

	it("fails rather than restarting when the cursor cannot be read", async () => {
		const e = env();
		writeCursor({ seq: 5, held: [] }, e);
		writeFileSync(join(mirrorDir(e), "cursor.json"), "{ not json");
		const client = windows({ lessons: [], has_more: false });

		const outcome = await pull({ client, env: e });

		expect(outcome.kind).toBe("failed");
		// Nothing was requested, because we do not know where to start from.
		expect(client.readDelta).not.toHaveBeenCalled();
	});
});

// ONL-182. The cursor passes a held lesson, so the main loop never sees it
// again. Without a retry, a machine on an older CLI loses every lesson pushed
// from a newer one for good, and upgrading does not bring them back.
describe("pull retries held lessons", () => {
	it("receives a held lesson once the contract accepts it", async () => {
		const e = env();
		writeCursor({ seq: 2, held: [1] }, e);
		// The same row, now readable: what an upgraded CLI sees.
		const client = feed({ 1: lesson(ids[0]), 2: lesson(ids[1]) });

		const outcome = await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledWith(0, 1);
		expect(outcome).toMatchObject({
			kind: "received",
			created: 1,
			released: 1,
			held: [],
			cursor: 2,
		});
		expect(stored(e)).toEqual([`${ids[0]}.json`]);
		expect(readCursor(e)).toEqual({ seq: 2, held: [] });
	});

	it("keeps holding a lesson the contract still refuses", async () => {
		const e = env();
		writeCursor({ seq: 2, held: [1] }, e);
		const client = feed({ 1: newer(ids[0]), 2: lesson(ids[1]) });

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", released: 0 });
		if (outcome.kind !== "received") return;
		expect(outcome.held).toHaveLength(1);
		expect(stored(e)).toEqual([]);
		expect(readCursor(e)).toEqual({ seq: 2, held: [1] });
	});

	// A deleted lesson takes its feed rows with it, so a held seq can vanish.
	// The window below it then answers with a later row, which is not the one
	// held and is not written from here: the main loop already handled it.
	it("lets go of a held seq the pool no longer has", async () => {
		const e = env();
		writeCursor({ seq: 2, held: [1] }, e);
		const client = feed({ 2: lesson(ids[1]) });

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", released: 0, held: [] });
		expect(stored(e)).toEqual([]);
		expect(readCursor(e)).toEqual({ seq: 2, held: [] });
	});

	it("keeps every held seq when a retry request fails", async () => {
		const e = env();
		writeCursor({ seq: 2, held: [1] }, e);
		const client = {
			readDelta: vi.fn().mockRejectedValue(new Error("network died")),
		};

		const outcome = await pull({ client, env: e });

		expect(outcome.kind).toBe("failed");
		expect(readCursor(e)).toEqual({ seq: 2, held: [1] });
	});

	// A re-fetched window passes a held row a second time. One lesson is one
	// entry, however often it is refused.
	it("holds a seq once however often it is refused", async () => {
		const e = env();
		writeCursor({ seq: 0, held: [1] }, e);
		const client = feed({ 1: newer(ids[0]) });

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", cursor: 1 });
		if (outcome.kind !== "received") return;
		expect(outcome.held).toHaveLength(1);
		expect(readCursor(e)).toEqual({ seq: 1, held: [1] });
	});
});
