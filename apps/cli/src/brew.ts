import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { label, muted, ok, PLAIN, type Theme, warn } from "./ui";

/** The tap this CLI ships from, and the formula inside it. */
export const TAP = "onlooker-community/tap";
const FORMULA = `${TAP}/onlooker`;

/**
 * The one trust file `brew` reads in this environment, and why.
 *
 * Mirrors /opt/homebrew/bin/brew (Homebrew 7.0.10, lines 165-173), which picks
 * HOMEBREW_USER_CONFIG_HOME from the first of XDG_CONFIG_HOME,
 * HOMEBREW_XDG_CONFIG_HOME and ~/.homebrew, testing each with `-n` so an empty
 * value counts as unset. `Homebrew::Trust.trust_file` and `items.sh` both read
 * `trust.json` from that one directory and never fall back to another.
 *
 * That is the whole of ONL-65. A `brew trust` run from a shell with
 * XDG_CONFIG_HOME writes one file, a later `brew upgrade` from a shell without
 * it reads the other, and a tap that a file on disk plainly trusts is refused.
 */
export function liveTrustFile(
	env: NodeJS.ProcessEnv,
	home: string,
): { path: string; because: string } {
	if (env.XDG_CONFIG_HOME) {
		return {
			path: join(env.XDG_CONFIG_HOME, "homebrew", "trust.json"),
			because: "XDG_CONFIG_HOME is set",
		};
	}
	if (env.HOMEBREW_XDG_CONFIG_HOME) {
		return {
			path: join(env.HOMEBREW_XDG_CONFIG_HOME, "homebrew", "trust.json"),
			because: "HOMEBREW_XDG_CONFIG_HOME is set",
		};
	}
	return {
		path: join(home, ".homebrew", "trust.json"),
		because: "XDG_CONFIG_HOME is not set",
	};
}

export type BrewTrust =
	| { kind: "not-homebrew" }
	| {
			kind: "trusted";
			file: string;
			because: string;
			/** Existing trust files another shell would read, that refuse the tap. */
			untrustedElsewhere: string[];
	  }
	| {
			kind: "untrusted";
			file: string;
			because: string;
			/** Trust files that do trust the tap, which brew is not reading. */
			trustedElsewhere: string[];
	  }
	| { kind: "unreadable"; file: string; reason: string };

/**
 * Whether `brew upgrade` will consider this CLI's formula at all.
 *
 * Only asked of a Homebrew install, recognized by the running script resolving
 * into a Cellar. A source checkout or an npm install never consults brew, and
 * a finding about brew there would only be noise.
 *
 * Trusting the tap or just the formula is enough: `items.sh` admits an item if
 * either list names it.
 */
export function checkBrewTrust(opts: {
	env?: NodeJS.ProcessEnv;
	home?: string;
	binPath?: string;
}): BrewTrust {
	const env = opts.env ?? process.env;
	const home = opts.home ?? homedir();
	if (!installedByHomebrew(opts.binPath ?? process.argv[1])) {
		return { kind: "not-homebrew" };
	}

	const { path: file, because } = liveTrustFile(env, home);
	let live: boolean | null;
	try {
		live = trusts(file);
	} catch (error) {
		return { kind: "unreadable", file, reason: (error as Error).message };
	}

	// Every other place brew could be pointed at by a different shell. The
	// XDG default is listed explicitly because a shell with XDG_CONFIG_HOME
	// set almost always points it at ~/.config.
	const others = [
		join(home, ".homebrew", "trust.json"),
		join(home, ".config", "homebrew", "trust.json"),
		...(env.XDG_CONFIG_HOME
			? [join(env.XDG_CONFIG_HOME, "homebrew", "trust.json")]
			: []),
		...(env.HOMEBREW_XDG_CONFIG_HOME
			? [join(env.HOMEBREW_XDG_CONFIG_HOME, "homebrew", "trust.json")]
			: []),
	].filter((path, i, all) => path !== file && all.indexOf(path) === i);

	// An unreadable file elsewhere is not this shell's problem, and the live
	// verdict does not rest on it, so it is left out rather than reported.
	const elsewhere = others.map((path) => {
		try {
			return { path, trusted: trusts(path) };
		} catch {
			return { path, trusted: null };
		}
	});

	if (live === true) {
		return {
			kind: "trusted",
			file,
			because,
			untrustedElsewhere: elsewhere
				.filter((o) => o.trusted === false)
				.map((o) => o.path),
		};
	}
	return {
		kind: "untrusted",
		file,
		because,
		trustedElsewhere: elsewhere
			.filter((o) => o.trusted === true)
			.map((o) => o.path),
	};
}

/**
 * Doctor's lines about Homebrew, or none when the CLI did not come from it.
 *
 * The untrusted case says why an earlier `brew trust` did not count, because
 * brew's own refusal tells someone to run the command they already ran.
 */
export function brewTrustLines(
	check: BrewTrust,
	home: string,
	theme: Theme = PLAIN,
): string[] {
	const tilde = (path: string) =>
		path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
	const head = label(theme, "Homebrew:");

	switch (check.kind) {
		case "not-homebrew":
			return [];
		case "unreadable":
			return [
				`${head} ${warn(theme, "○")} could not read ${tilde(check.file)}, the trust file brew reads here: ${check.reason}`,
			];
		case "trusted": {
			const lines = [
				`${head} ${ok(theme, "●")} trusts ${TAP} ${muted(theme, `(${tilde(check.file)}, because ${check.because})`)}`,
			];
			if (check.untrustedElsewhere.length > 0) {
				const files = check.untrustedElsewhere.map(tilde).join(" and ");
				lines.push(
					`${label(theme, "Caution:")}  ${warn(theme, `${files} does not trust it. brew reads that file from a shell where XDG_CONFIG_HOME is set differently, and would skip onlooker there.`)}`,
				);
			}
			return lines;
		}
		default: {
			const elsewhere =
				check.trustedElsewhere.length > 0
					? ` ${check.trustedElsewhere.map(tilde).join(" and ")} trusts it, but brew reads only one trust file.`
					: "";
			return [
				`${head} ${warn(theme, "○")} brew upgrade will skip onlooker: ${tilde(check.file)}, the trust file brew reads because ${check.because}, does not trust ${TAP}.${elsewhere} Run: brew trust ${TAP}`,
			];
		}
	}
}

/** Whether this finding should fail doctor's exit code. */
export function brewTrustFails(check: BrewTrust): boolean {
	return check.kind === "untrusted" || check.kind === "unreadable";
}

/**
 * `true` or `false` for a trust file that exists, `null` for one that does
 * not. Throws for one that exists and cannot be read, which the caller
 * decides how to report.
 */
function trusts(path: string): boolean | null {
	if (!existsSync(path)) return null;
	const store = JSON.parse(readFileSync(path, "utf8")) as Record<
		string,
		unknown
	>;
	const names = (key: string) =>
		Array.isArray(store[key]) ? (store[key] as unknown[]) : [];
	return (
		names("trustedtaps").includes(TAP) ||
		names("trustedformulae").includes(FORMULA)
	);
}

function installedByHomebrew(binPath: string | undefined): boolean {
	if (binPath === undefined) return false;
	let resolved = binPath;
	try {
		resolved = realpathSync(binPath);
	} catch {
		// A path that does not exist (a test's fake Cellar path, or a
		// binary deleted mid-upgrade) is judged as written.
	}
	return resolved.includes("/Cellar/onlooker/");
}
