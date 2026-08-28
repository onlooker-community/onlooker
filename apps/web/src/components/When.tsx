import type { CSSProperties } from "react";

/**
 * An instant, rendered so its value survives being read by a machine.
 * `toLocaleDateString` alone would make any assertion about it depend on the
 * runner's locale.
 *
 * Shared by MachinesPage and LessonsPage rather than duplicated - both
 * needed the identical `<time>`/locale-date pairing and differed only in
 * how the text should look beside the rest of their row.
 */
export function When({ iso, style }: { iso: string; style?: CSSProperties }) {
	return (
		<time dateTime={iso} style={style}>
			{new Date(iso).toLocaleDateString()}
		</time>
	);
}
