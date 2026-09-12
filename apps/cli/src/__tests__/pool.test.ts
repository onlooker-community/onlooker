import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cursorPath,
	migrateLegacyPool,
	mirrorDir,
	readCursor,
	writeCursor,
	writeLesson,
} from "../pool";

const ID = "01KZ45MKAM734ZS7JK24D2DK0R";
const OTHER = "01KZ45MKAM734ZS7JK24D2DK0S";

function env(): NodeJS.ProcessEnv {
	return { ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-pool-")) };
}

/**
 * A lesson-shaped object. These tests are about storage, not the contract, so
 * only `id` and one mutable field matter - the cast keeps that honest rather
 * than pretending to build a fully valid lesson.
 */
// biome-ignore lint/suspicious/noExplicitAny: storage tests, not contract tests
const lesson = (id: string, claim = "because it was measured"): any => ({
	schema_version: 1,
	id,
	claim,
	evidence: [],
	applies_to: {},
	status: "promoted",
});

describe("readCursor", () => {
	// A machine that has never pulled starts at the beginning rather than
	// skipping whatever already exists - 0 means "send me everything".
	it("is 0 before anything has been pulled", () => {
		expect(readCursor(env())).toBe(0);
	});

	it("round-trips through writeCursor", () => {
		const e = env();
		writeCursor(42, e);
		expect(readCursor(e)).toBe(42);
	});

	// A cursor we cannot read is not a cursor of 0. Restarting from the
	// beginning is safe, but doing it silently calls a corrupt file a fresh
	// machine and hides that something damaged it.
	it("throws rather than resetting when the cursor file is unreadable", () => {
		const e = env();
		writeCursor(7, e);
		writeFileSync(cursorPath(e), "{ not json");
		expect(() => readCursor(e)).toThrow();
	});

	it("throws when the cursor file holds something that is not an integer", () => {
		const e = env();
		writeCursor(7, e);
		writeFileSync(cursorPath(e), JSON.stringify({ seq: "twelve" }));
		expect(() => readCursor(e)).toThrow();
	});
});

describe("writeLesson", () => {
	it("writes one file per lesson, named by id", () => {
		const e = env();
		writeLesson(lesson(ID), e);
		const written = JSON.parse(
			readFileSync(join(mirrorDir(e), `${ID}.json`), "utf8"),
		);
		expect(written.id).toBe(ID);
	});

	it("reports created, then unchanged, then updated", () => {
		const e = env();
		expect(writeLesson(lesson(ID), e)).toBe("created");
		expect(writeLesson(lesson(ID), e)).toBe("unchanged");
		expect(writeLesson(lesson(ID, "because it changed"), e)).toBe("updated");
	});

	// Upsert by id: the server sends a lesson again whenever it changed, and
	// re-sends a whole window after an interrupted run. Both must converge on
	// one file rather than accumulating.
	it("leaves one file when the same id arrives twice", () => {
		const e = env();
		writeLesson(lesson(ID), e);
		writeLesson(lesson(ID, "because it changed"), e);

		const written = JSON.parse(
			readFileSync(join(mirrorDir(e), `${ID}.json`), "utf8"),
		);
		expect(written.claim).toBe("because it changed");
		expect(readdirSync(mirrorDir(e))).toEqual([`${ID}.json`]);
	});

	it("keeps separate ids separate", () => {
		const e = env();
		writeLesson(lesson(ID), e);
		writeLesson(lesson(OTHER), e);

		expect(readdirSync(mirrorDir(e)).sort()).toEqual([
			`${ID}.json`,
			`${OTHER}.json`,
		]);
	});

	// The filename is built from server-supplied data. ZUlid is
	// [0-9A-HJKMNP-TV-Z]{26}, which cannot hold a separator or a dot - but the
	// check is asserted here rather than inherited, so a future contract change
	// fails at the filename instead of escaping the directory.
	it("refuses an id that is not a ULID", () => {
		const e = env();
		expect(() => writeLesson(lesson("../../etc/passwd"), e)).toThrow(/ULID/);
		expect(() => writeLesson(lesson("nope"), e)).toThrow(/ULID/);
		expect(() => writeLesson(lesson(ID.toLowerCase()), e)).toThrow(/ULID/);
	});

	// The check runs before anything touches the filesystem, so a refused id
	// does not even create the directory. Asserted as "nothing exists" rather
	// than "the directory is empty", because the stronger statement is the
	// true one and an empty directory would also pass the weaker one.
	it("touches the filesystem not at all when it refuses an id", () => {
		const e = env();
		try {
			writeLesson(lesson("../escape"), e);
		} catch {
			// expected
		}
		expect(existsSync(mirrorDir(e))).toBe(false);
	});

	it("creates the pool directory if it does not exist", () => {
		const e = env();
		expect(() => writeLesson(lesson(ID), e)).not.toThrow();
	});

	// Rename is atomic within a directory, so a reader never sees half a
	// lesson. The temp file must not survive as a stray either.
	it("leaves no temp file behind", () => {
		const e = env();
		writeLesson(lesson(ID), e);
		expect(readdirSync(mirrorDir(e)).filter((f) => f.endsWith(".tmp"))).toEqual(
			[],
		);
	});
});

describe("mirrorDir", () => {
	// "pool" means the hosted set in every user-facing string this CLI
	// prints, so the local copy sharing that name collided with its own
	// output. schema.ts already calls this thing the mirror.
	it("is ~/.onlooker/mirror, not pool", () => {
		const e = env();
		expect(mirrorDir(e)).toBe(join(e.ONLOOKER_DIR as string, "mirror"));
	});
});

describe("migrateLegacyPool", () => {
	// pool/ shipped in 2.4.0. A machine that pulled before the rename has one,
	// and leaving it beside mirror/ is the confusion the rename exists to end.
	it("moves an existing pool directory and says so", () => {
		const e = env();
		const legacy = join(e.ONLOOKER_DIR as string, "pool");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "cursor.json"), JSON.stringify({ seq: 9 }));

		const note = migrateLegacyPool(e);

		expect(note).toMatch(/pool/);
		expect(note).toMatch(/mirror/);
		expect(readCursor(e)).toBe(9);
		expect(existsSync(legacy)).toBe(false);
	});

	it("says nothing when there is nothing to move", () => {
		expect(migrateLegacyPool(env())).toBeNull();
	});

	// Never clobber. If both exist, the new one is authoritative and the old
	// one is left for a person to look at rather than silently merged -
	// merging two cursors would be a guess about which is further along.
	it("leaves both alone when mirror already exists", () => {
		const e = env();
		mkdirSync(join(e.ONLOOKER_DIR as string, "pool"), { recursive: true });
		writeCursor(3, e);

		expect(migrateLegacyPool(e)).toMatch(/both/i);
		expect(existsSync(join(e.ONLOOKER_DIR as string, "pool"))).toBe(true);
		expect(readCursor(e)).toBe(3);
	});
});
