/**
 * A read in three states. "Failed" is kept apart from "loaded and empty" so a
 * panel can never render an empty answer for a read that did not succeed.
 */
export type Load<T> =
	| { kind: "loading" }
	| { kind: "loaded"; value: T }
	| { kind: "failed"; message: string };
