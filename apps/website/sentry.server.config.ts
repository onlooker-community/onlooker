import handler from "@astrojs/cloudflare/entrypoints/server";
import * as Sentry from "@sentry/cloudflare";
import { type WebsiteEnv, websiteMonitoringConfig } from "./src/lib/monitoring";

export default Sentry.withSentry<WebsiteEnv>(websiteMonitoringConfig, handler);
