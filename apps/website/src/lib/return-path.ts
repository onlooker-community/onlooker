// Its own module, not part of lib/glossary.ts, because the glossary page's
// browser script imports it, and that would bundle every definition into the
// script for nothing.

// A post's path as postPath writes it: /blog/<slug>/, the slug kebab-case.
// Anything else - another origin, a protocol-relative URL, a dot segment, a
// page that isn't a post - is refused rather than cleaned up.
const POST_PATH = /^\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;

/**
 * Where the glossary's back link may point, given the `from` a <Term> link
 * put in its URL. Null means show no back link.
 *
 * `from` arrives in a URL anyone can write, so the back link only ever goes
 * to a post on this site.
 */
export function returnPath(from: string | null): string | null {
	return from !== null && POST_PATH.test(from) ? from : null;
}
