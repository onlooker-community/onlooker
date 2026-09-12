import type { Integration } from "@sentry/core";
import { type MonitoringConfig, sentryOptions } from "./options";

export interface BrowserMonitoringOptions {
	/**
	 * Whether Sentry installs its own `error` / `unhandledrejection` listeners.
	 *
	 * Required, because the right answer differs by app. apps/web has its own
	 * listeners feeding a `fanout` monitor, so Sentry's would report every
	 * uncaught error twice. apps/website has none, so turning Sentry's off
	 * would mean reporting nothing.
	 */
	captureGlobalErrors: boolean;
	/** Runtime-specific additions - tracing, replay - from the app's own SDK. */
	integrations?: Integration[];
}

/** Spread into `Sentry.init` from whichever browser SDK the app uses. */
export function browserOptions(
	config: MonitoringConfig,
	{ captureGlobalErrors, integrations = [] }: BrowserMonitoringOptions,
) {
	return {
		...sentryOptions(config),
		integrations: (defaults: Integration[]) => [
			...(captureGlobalErrors
				? defaults
				: defaults.filter(({ name }) => name !== "GlobalHandlers")),
			...integrations,
		],
	};
}
