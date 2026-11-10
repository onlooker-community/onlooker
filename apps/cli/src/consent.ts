import { readConfig } from "./config";
import { muted, ok, type Theme, warn } from "./ui";

export type CrashConsent =
	| { on: true }
	| { on: false; why: "not-chosen" | "turned-off" | "unreadable" }
	| {
			on: false;
			why: "environment";
			variable: "DO_NOT_TRACK" | "ONLOOKER_CRASH_REPORTS";
	  };

/** Values that mean "unset" under the DO_NOT_TRACK convention. */
const TRACKING_ALLOWED = new Set(["", "0", "false"]);
const OFF = new Set(["0", "false", "off", "no"]);

/**
 * Whether this machine has agreed to send the CLI's crash reports.
 *
 * Only `cli.json` can say yes, and only `onlooker crash-reports on` writes
 * that. The environment is checked first and can only say no, so a recorded
 * yes is still overridden by DO_NOT_TRACK on a machine that sets it.
 *
 * Never throws: it runs inside the crash handler, where a config that cannot
 * be read must mean "not reported", not a second error.
 */
export function crashConsent(
	env: NodeJS.ProcessEnv = process.env,
): CrashConsent {
	const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
	if (dnt !== undefined && !TRACKING_ALLOWED.has(dnt)) {
		return { on: false, why: "environment", variable: "DO_NOT_TRACK" };
	}
	const own = env.ONLOOKER_CRASH_REPORTS?.trim().toLowerCase();
	if (own !== undefined && OFF.has(own)) {
		return {
			on: false,
			why: "environment",
			variable: "ONLOOKER_CRASH_REPORTS",
		};
	}

	let stored: boolean | undefined;
	try {
		stored = readConfig(env).crashReports;
	} catch {
		return { on: false, why: "unreadable" };
	}
	if (stored === true) return { on: true };
	return { on: false, why: stored === false ? "turned-off" : "not-chosen" };
}

/** One line for `status` and `crash-reports`. */
export function describeConsent(consent: CrashConsent, theme: Theme): string {
	if (consent.on) return ok(theme, "on");
	switch (consent.why) {
		case "not-chosen":
			return `off ${muted(theme, "- `onlooker crash-reports on` to send them")}`;
		case "turned-off":
			return "off";
		case "environment":
			return `off ${muted(theme, `- ${consent.variable} is set`)}`;
		case "unreadable":
			return warn(theme, "off - cli.json could not be read");
	}
}
