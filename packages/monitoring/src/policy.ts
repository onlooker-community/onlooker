import { redactSecrets } from "@onlooker/api-contract";

/**
 * Strip anything credential-shaped from text bound for a monitor.
 *
 * The patterns live in @onlooker/api-contract (see redact.ts there for why
 * that package and not this one); this is the name adapters reach for, so that
 * every string an adapter hands a provider - messages, exception values, URLs,
 * breadcrumbs, transaction names - goes through the same four passes the
 * vendor-less client-error path already uses.
 */
export const scrubText = redactSecrets;

/**
 * The one vocabulary every app labels events with.
 *
 * A provider treats `prod` and `production` as two environments, so a
 * dashboard filtered on one silently omits whatever an app sent as the other.
 * apps/website shipped with `DEV ? "development" : "production"`, which labels
 * a staging build as production - the case this closes.
 */
export type MonitoringEnvironment = "development" | "staging" | "production";

const ALIASES: Record<string, MonitoringEnvironment> = {
	production: "production",
	prod: "production",
	staging: "staging",
	stage: "staging",
	development: "development",
	dev: "development",
	local: "development",
	test: "development",
};

/**
 * Map whatever an app knows about where it runs onto the shared vocabulary.
 *
 * `fallback` is required rather than defaulted. An unrecognised value has no
 * safe answer here: guessing "development" hides a production fault from
 * anyone filtering on production, and guessing "production" pages someone for
 * a laptop. The caller knows which mistake it would rather make.
 */
export function resolveEnvironment(
	value: string | undefined,
	fallback: MonitoringEnvironment,
): MonitoringEnvironment {
	const key = value?.trim().toLowerCase();
	return (key && ALIASES[key]) || fallback;
}
