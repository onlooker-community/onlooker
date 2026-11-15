import { describe, expect, it } from "vitest";
import { incompletePages } from "../lib/complete-pages";

const page = (path: string, html: string) => ({ path, html });

describe("incompletePages", () => {
	it("passes a complete page", () => {
		expect(
			incompletePages([
				page("blog/a/index.html", "<!DOCTYPE html><html><body></body></html>"),
			]),
		).toEqual([]);
	});

	// What a component that throws mid-render leaves behind: the stream stops
	// where it threw, and astro build still exits 0 (ONL-294). Measured on a
	// post with a bad <Term> id, which built as this - its header, no body.
	it("names a page that stops before </html>", () => {
		expect(
			incompletePages([
				page("blog/ok/index.html", "<html><body></body></html>"),
				page(
					"blog/cut/index.html",
					'<!DOCTYPE html><html lang="en"><head></head><body><main><article class="prose"><header class="post-header"><h1>Scratch</h1></header>',
				),
			]),
		).toEqual(["blog/cut/index.html"]);
	});

	// Astro puts a page's own <script> after </html> (the home page and
	// /glossary both build that way), so "ends with </html>" would fail two
	// complete pages. Reaching </html> at all is the test.
	it("passes a page whose script follows </html>", () => {
		expect(
			incompletePages([
				page(
					"glossary/index.html",
					'<html><body></body></html> <script type="module" src="/_astro/x.js"></script>',
				),
			]),
		).toEqual([]);
	});

	it("reads the closing tag in any case", () => {
		expect(
			incompletePages([page("index.html", "<HTML><BODY></BODY></HTML>")]),
		).toEqual([]);
	});

	// A post that writes about the tag shows it escaped, so prose cannot pass
	// a page that was cut off before its real end.
	it("does not count an escaped </html> in the text", () => {
		expect(
			incompletePages([
				page(
					"blog/tags/index.html",
					"<html><body><p>close it with &lt;/html&gt;</p>",
				),
			]),
		).toEqual(["blog/tags/index.html"]);
	});
});
