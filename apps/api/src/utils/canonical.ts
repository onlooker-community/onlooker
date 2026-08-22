/**
 * Deterministic JSON, used to decide whether two lessons are the same lesson.
 *
 * Object keys are sorted; array order is preserved because it is semantic -
 * applies_to.stack is a list, and reordering it describes a different lesson.
 *
 * This is not a general canonical-JSON implementation and does not try to be.
 * It handles what ZLesson can produce: objects, arrays, strings, finite
 * numbers, booleans and null. Lessons are parsed by zod before this ever sees
 * them, so undefined, functions and symbols cannot reach it.
 */
export function canonicalize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}

	if (Array.isArray(value)) {
		return `[${value.map(canonicalize).join(",")}]`;
	}

	const entries = Object.entries(value as Record<string, unknown>).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	);

	return `{${entries
		.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
		.join(",")}}`;
}
