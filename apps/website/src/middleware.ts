import { defineMiddleware } from 'astro:middleware';
import { SITE_LAUNCHED } from 'astro:env/server';

// While SITE_LAUNCHED is false, only `/` (the coming-soon page) is reachable;
// every other URL bounces back to it. New pages opt out of this by either
// launching (flip the env) or being prerendered (middleware doesn't run for
// static assets served via the Cloudflare ASSETS binding).
export const onRequest = defineMiddleware((context, next) => {
  if (SITE_LAUNCHED) return next();
  if (context.url.pathname === '/') return next();
  return context.redirect('/', 307);
});
