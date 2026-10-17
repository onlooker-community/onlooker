/**
 * Does this error report a foreign-key violation?
 *
 * NO TABLE ARGUMENT, unlike `isUniqueViolationOn` in db/lessons.ts, and the
 * asymmetry is SQLite's rather than an omission: a unique violation names the
 * index and its columns in the message, while a foreign-key failure is the
 * bare string "FOREIGN KEY constraint failed" with nothing to scope a match to.
 *
 * So a caller CANNOT ask "did this table's constraint fail", and the only safe
 * way to use this is around a single statement whose foreign keys are known by
 * reading it. A catch spanning several writes cannot tell which one failed, and
 * would answer for the wrong one.
 *
 * Lives here rather than beside `isUniqueViolationOn` because a route needs it:
 * importing it out of db/lessons.ts would pass the lesson-visibility source
 * guard, which matches queries rather than imports, and would still read as a
 * route reaching into the lesson-query home. This file queries nothing.
 */
export function isForeignKeyViolation(error: unknown): boolean {
	return (
		error instanceof Error &&
		/FOREIGN KEY constraint failed/i.test(error.message)
	);
}
