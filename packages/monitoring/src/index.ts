/**
 * The monitoring contract every app reports through.
 *
 * Named for the job rather than the vendor. Sentry arrived in apps/website as
 * direct `@sentry/*` calls, and repeating that in apps/web and apps/api would
 * have spread one provider through every call site - so a change of provider
 * would be an edit everywhere, and a type named after it would be wrong the day
 * after. App code imports `Monitor` from here; exactly one file per app imports
 * an adapter (today `@onlooker/monitoring-sentry`) and hands the result back.
 */

export {
	type Attributes,
	type CaptureContext,
	fanout,
	guarded,
	type Level,
	type Monitor,
	type MonitorUser,
	noopMonitor,
	type SpanOptions,
} from "./monitor";
export {
	type MonitoringEnvironment,
	resolveEnvironment,
	scrubText,
} from "./policy";
