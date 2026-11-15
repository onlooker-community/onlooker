import { basename } from "node:path";

/**
 * The label derivation this CLI implements (ONL-197, problem 7). Remote rows
 * are last-writer-wins across machines, so two CLIs that derived
 * differently would alternate a key between two names. Any change to this
 * file's output is a new number, and the server must accept it first.
 */
export const DERIVATION = 1;

const MAX_LABEL_BYTES = 200;
/** The server's FORBIDDEN, in apps/api/src/routes/label-rules.ts. */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
/** A URL scheme git understands; scp-like remotes have none. */
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
/** scp-like `[user@]host:path`, which git takes only when no slash precedes the colon. */
const SCP = /^(?:[^@/]+@)?[^/:]+:(?!\/\/)(.+)$/;

/** Whether the server would accept `label`, so a row is not spent on a refusal. */
export function isValidLabel(label: string): boolean {
	return (
		!FORBIDDEN.test(label) &&
		label.trim() !== "" &&
		new TextEncoder().encode(label).length <= MAX_LABEL_BYTES
	);
}

/**
 * `owner/repo` from an origin URL, or null.
 *
 * Only the path is ever kept, so userinfo, host and port cannot reach the
 * label whatever form the URL takes. A local remote (`file://`, a path) has
 * no name worth sending and its path would be a disclosure, so it is null.
 */
export function remoteLabel(url: string): string | null {
	let path: string;
	const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
	if (scheme !== undefined) {
		if (scheme === "file") return null;
		try {
			path = new URL(url.replace(SCHEME, "https://")).pathname;
		} catch {
			return null;
		}
	} else {
		const scp = SCP.exec(url);
		// A Windows drive (`C:\…`) matches scp's shape; a one-letter host is
		// what git itself treats as a local path.
		if (!scp || /^[a-z]:/i.test(url)) return null;
		path = scp[1] ?? "";
	}

	const segments = path
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2) return null;
	const owner = segments[segments.length - 2] ?? "";
	const repo = segments[segments.length - 1] ?? "";

	let label: string;
	try {
		label = `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
	} catch {
		return null;
	}
	// Decoded only to check: an encoded `@`, `:` or `/` is a name that could
	// carry a credential or a second path, and none is a real repo name.
	if (/[@:]/.test(label) || label.split("/").length !== 2) return null;
	return isValidLabel(label) ? label : null;
}

/** The repo root's folder name, or null. */
export function rootLabel(root: string): string | null {
	const name = basename(root.replace(/\/+$/, ""));
	return name !== "" && isValidLabel(name) ? name : null;
}
