/**
 * One set of rules for every writer, so a label the CLI derives is held to
 * what a person may type.
 */
import { ApiError } from "../types";

/** A project key as the CLI derives it: the first 12 hex of a SHA-256. */
export const PROJECT_KEY = /^[0-9a-f]{12}$/;

/**
 * Bounded in bytes, because the cap exists to bound storage, and a name of
 * multi-byte characters is larger than its length suggests.
 */
export const MAX_LABEL_BYTES = 200;

/**
 * Characters a name has no use for and a display can be fooled by.
 *
 * Cc is the control characters, newlines included. Cf is the invisible
 * formatting ones - zero-width spaces and joiners, the byte-order mark, and
 * the bidi overrides that reorder whatever follows them. Zl and Zp are the
 * line and paragraph separators. Cs, under the `u` flag, is a lone surrogate
 * that JSON can carry and nothing can render.
 */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** The label to store, trimmed, or a 400 saying what is wrong with it. */
export function validLabel(raw: unknown): string {
	if (typeof raw !== "string") {
		throw new ApiError(
			400,
			"invalid_label",
			"label must be a string, or null to clear it",
		);
	}
	// Checked before trimming, so a trailing newline is refused rather than
	// quietly removed - it is never part of a name someone meant to type.
	if (FORBIDDEN.test(raw)) {
		throw new ApiError(
			400,
			"invalid_label",
			"label must not contain control or invisible formatting characters",
		);
	}
	const label = raw.trim();
	if (label === "") {
		throw new ApiError(400, "invalid_label", "label must not be empty");
	}
	if (new TextEncoder().encode(label).length > MAX_LABEL_BYTES) {
		throw new ApiError(
			400,
			"invalid_label",
			`label must be at most ${MAX_LABEL_BYTES} bytes`,
		);
	}
	return label;
}
