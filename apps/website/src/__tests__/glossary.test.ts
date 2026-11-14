import { readdirSync, readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import Term from "../components/Term.astro";
import { GLOSSARY } from "../data/glossary";
import { glossaryHref, undefinedTermIds } from "../lib/glossary";
import { returnPath } from "../lib/return-path";
import GlossaryPage from "../pages/glossary.astro";

const BLOG = new URL("../content/blog/", import.meta.url);

describe("GLOSSARY", () => {
	// The ids are the anchors posts link to, so a duplicate would send one
	// term's links to the other's definition.
	it("has no duplicate ids", () => {
		const ids = GLOSSARY.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	// Kebab-case so an anchor never needs escaping in a URL or a selector.
	it("uses kebab-case ids", () => {
		for (const { id } of GLOSSARY) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
	});

	it("gives every term a definition", () => {
		for (const e of GLOSSARY) {
			expect(e.term.trim()).not.toBe("");
			expect(e.definition.trim()).not.toBe("");
		}
	});

	it("lists entries alphabetically, as the page shows them", () => {
		const terms = GLOSSARY.map((e) => e.term.toLowerCase());
		expect(terms).toEqual([...terms].sort());
	});
});

describe("glossaryHref", () => {
	it("links to the entry's anchor on the glossary page", () => {
		expect(glossaryHref("contrast-arena")).toBe("/glossary/#contrast-arena");
	});

	// This is what makes a typo in a post fail the build instead of shipping
	// a link to nowhere.
	it("throws for a term the glossary does not define", () => {
		expect(() => glossaryHref("contrast-arnea")).toThrow(/contrast-arnea/);
	});
});

describe("undefinedTermIds", () => {
	it("finds a <Term> id the glossary does not define", () => {
		expect(
			undefinedTermIds('A <Term id="contrast-arnea">contrast arena</Term>.'),
		).toEqual(["contrast-arnea"]);
	});

	it("passes ids the glossary defines", () => {
		expect(
			undefinedTermIds(
				"<Term id=\"wave\">wave</Term> and <Term id='home-repo'>home repo</Term>",
			),
		).toEqual([]);
	});

	it("reads an id on a <Term> whose attributes span lines", () => {
		expect(undefinedTermIds('<Term\n  id="nope"\n>x</Term>')).toEqual(["nope"]);
	});

	// Every committed post, so a typo fails `pnpm test` as well as the build.
	for (const file of readdirSync(BLOG).filter((f) => f.endsWith(".mdx"))) {
		it(`${file} links only terms the glossary defines`, () => {
			expect(
				undefinedTermIds(readFileSync(new URL(file, BLOG), "utf8")),
			).toEqual([]);
		});
	}
});

describe("/glossary", () => {
	async function render(): Promise<string> {
		const container = await AstroContainer.create();
		return container.renderToString(GlossaryPage);
	}

	// Rendered rather than read as source: the anchor a link lands on is the
	// id attribute in the HTML, not the id string in the data file.
	it("gives every entry an anchor its links land on", async () => {
		const html = await render();
		for (const { id, term } of GLOSSARY) {
			expect(html).toMatch(new RegExp(`<dt[^>]*id="${id}"[^>]*>${term}</dt>`));
		}
	});

	// Prerendered for the blog's reason: it is static content.
	it("is prerendered", () => {
		expect(
			readFileSync(new URL("../pages/glossary.astro", import.meta.url), "utf8"),
		).toMatch(/export const prerender = true;/);
	});
});

describe("returnPath", () => {
	it("accepts a post's path", () => {
		expect(returnPath("/blog/contrast-arena/")).toBe("/blog/contrast-arena/");
	});

	// `from` is read from the URL, so anyone can write a link with any value.
	// Only a post on this site may become the back link's target.
	for (const from of [
		null,
		"",
		"https://example.com/blog/x/",
		"//example.com/blog/x/",
		"/blog/../signup/",
		"/blog/",
		"/blog/x",
		"/signup/",
		"javascript:alert(1)",
	]) {
		it(`refuses ${JSON.stringify(from)}`, () => {
			expect(returnPath(from)).toBeNull();
		});
	}
});

describe("/glossary back link", () => {
	// Hidden until the page's script finds a `from` it accepts, so a reader who
	// opened the glossary directly never sees a link back to nowhere.
	it("is rendered hidden", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(GlossaryPage);
		expect(html).toMatch(
			/<a[^>]*data-back[^>]*hidden[^>]*>|<a[^>]*hidden[^>]*data-back[^>]*>/,
		);
	});
});

describe("Term", () => {
	async function render(id: string, text: string): Promise<string> {
		const container = await AstroContainer.create();
		return container.renderToString(Term, {
			props: { id },
			slots: { default: text },
			request: new Request("https://onlooker.dev/blog/a-post/"),
		});
	}

	it("links its text to the term's entry, saying which post it came from", async () => {
		const html = await render("home-repo", "home repo");
		expect(html).toMatch(
			/<a[^>]*href="\/glossary\/\?from=%2Fblog%2Fa-post%2F#home-repo"[^>]*>home repo<\/a>/,
		);
	});

	it("carries the definition as the link's tooltip", async () => {
		const html = await render("home-repo", "home repo");
		const tip = html.match(
			/<span[^>]*role="tooltip"[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/,
		);
		// Astro escapes the definition's apostrophe; the browser shows it.
		expect(tip?.[2].replaceAll("&#39;", "'")).toContain(
			GLOSSARY.find((e) => e.id === "home-repo")?.definition,
		);
		// Without aria-describedby a screen reader hears the link and never the
		// definition the mouse user sees.
		expect(html).toMatch(new RegExp(`<a[^>]*aria-describedby="${tip?.[1]}"`));
	});

	it("fails to render a term the glossary does not define", async () => {
		await expect(render("not-a-term", "x")).rejects.toThrow(/not-a-term/);
	});
});
