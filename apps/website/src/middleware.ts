import { SITE_LAUNCHED } from "astro:env/server";
import { defineMiddleware } from "astro:middleware";
import { isPublicBeforeLaunch } from "./lib/launch-gate";

// While SITE_LAUNCHED is false, only the paths launch-gate.ts names are
// reachable, and every other URL bounces to the coming-soon page. This runs
// for prerendered pages too, at build time, so a page is public only if it is
// named there.
export const onRequest = defineMiddleware((context, next) => {
	if (SITE_LAUNCHED || isPublicBeforeLaunch(context.url.pathname))
		return next();
	return context.redirect("/", 307);
});
