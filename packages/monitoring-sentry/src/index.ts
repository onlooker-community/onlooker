/**
 * Sentry, behind @onlooker/monitoring's `Monitor`.
 *
 * The only package in the repo that imports `@sentry/*`. Replacing the
 * provider means writing a sibling of this package and changing the one
 * `monitoring.ts` in each app that imports it - nothing else names Sentry.
 *
 * Runtime-specific pieces live on subpaths so a browser bundle never pulls in
 * the Workers SDK: `./browser` for init options, `./worker` for the fetch
 * handler wrapper.
 */

export { createSentryMonitor } from "./monitor";
export { type MonitoringConfig, sentryOptions } from "./options";
