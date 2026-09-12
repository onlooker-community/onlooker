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
		expect(readCursor(e)).toBe(2);
	});

	it("starts from the stored cursor, not from zero", async () => {
		const e = env();
		writeCursor(5, e);
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
		writeCursor(3, e);
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
		expect(readCursor(e)).toBe(1);
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
		expect(readCursor(e)).toBe(0);
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
		writeCursor(10, e);
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
		writeCursor(10, e);
		const client = windows({
			lessons: [{ seq: 12, lesson: lesson(ids[0]) }],
			has_more: false,
		});

		await pull({ client, env: e });

		expect(client.readDelta).toHaveBeenCalledTimes(1);
		expect(client.readDelta).toHaveBeenCalledWith(10, expect.any(Number));
	});

	it("reports a lesson the contract refuses rather than writing it", async () => {
		const e = env();
		const client = windows({
			lessons: [
				{ seq: 1, lesson: { id: "not-a-ulid", claim: "x" } },
				{ seq: 2, lesson: lesson(ids[1]) },
			],
			has_more: false,
		});

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 1 });
		if (outcome.kind !== "received") return;
		expect(outcome.invalid).toHaveLength(1);
		// The valid lesson beside it still landed, and the cursor still moved.
		// One row the contract refuses must not wedge the mirror behind it
		// forever - that would be a permanent outage caused by one bad record.
		expect(readCursor(e)).toBe(2);
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

		writeCursor(0, e);
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
		writeCursor(4, e);
		const client = windows({ lessons: [], has_more: false });

		const outcome = await pull({ client, env: e });

		expect(outcome).toMatchObject({ kind: "received", created: 0, cursor: 4 });
	});

	it("fails rather than restarting when the cursor cannot be read", async () => {
		const e = env();
		writeCursor(5, e);
		writeFileSync(join(mirrorDir(e), "cursor.json"), "{ not json");
		const client = windows({ lessons: [], has_more: false });

		const outcome = await pull({ client, env: e });

		expect(outcome.kind).toBe("failed");
		// Nothing was requested, because we do not know where to start from.
		expect(client.readDelta).not.toHaveBeenCalled();
	});
});
