import { GLOSSARY, type GlossaryEntry } from "../data/glossary";

const IDS = new Set(GLOSSARY.map((e) => e.id));

// `<Term` then anything up to the tag's end, so attributes can span lines.
const TERM_ID = /<Term\b[^>]*?\bid=(["'])([^"']*)\1/g;

/**
 * The <Term> ids in a post's source that the glossary does not define.
 *
 * This, not glossaryHref's throw, is what fails the build for a typo, because
 * the adapter streams a prerendered page: a component that throws mid-render
 * leaves the HTML cut off where it threw and the build still exits 0
 * (measured 2026-11-14 - a post with a bad id built as its header and no
 * body). The blog's getStaticPaths checks every post with this before any
 * page starts rendering, where a throw does stop the build.
 */
export function undefinedTermIds(source: string): string[] {
	return [...source.matchAll(TERM_ID)]
		.map((m) => m[2])
		.filter((id) => !IDS.has(id));
}

/**
 * The entry for a glossary id. Throws for an id the glossary does not define.
 * That stops a component test, but not a build - see undefinedTermIds.
 */
export function glossaryEntry(id: string): GlossaryEntry {
	const entry = GLOSSARY.find((e) => e.id === id);
	if (!entry) {
		throw new Error(
			`<Term id="${id}">: no such glossary entry. Add it to src/data/glossary.ts, or fix the id.`,
		);
	}
	return entry;
}

/**
 * The link for a glossary term. `from` is the page the link sits on, which
 * the glossary turns into its back link (see lib/return-path.ts).
 *
 * Trailing slash for the reason postPath gives: production answers /glossary
 * with a redirect to /glossary/.
 */
export function glossaryHref(id: string, from?: string): string {
	glossaryEntry(id);
	const query = from ? `?from=${encodeURIComponent(from)}` : "";
	return `/glossary/${query}#${id}`;
}
