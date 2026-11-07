import { SITE_LAUNCHED } from "astro:env/server";
import { defineMiddleware } from "astro:middleware";

// While SITE_LAUNCHED is false, only `/` (the coming-soon page) is reachable;
// every other URL bounces back to it. New pages opt out of this by either
// launching (flip the env) or being prerendered (middleware doesn't run for
// static assets served via the Cloudflare ASSETS binding).
//
// /plugins and /blog are public today by the second route, and that is
// deliberate: they show what is real while the hosted product stays behind
// the waitlist. blog-routes.test.ts fails if a blog route stops prerendering.
export const onRequest = defineMiddleware((context, next) => {
	if (SITE_LAUNCHED) return next();
	if (context.url.pathname === "/") return next();
	return context.redirect("/", 307);
});
