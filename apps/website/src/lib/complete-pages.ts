import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

// The adapter streams each prerendered page. A component that throws after
// the page has started streaming leaves the HTML cut off where it threw, and
// astro build still exits 0, so the cut-off page deploys (ONL-294; found with
// a bad <Term> id, which built as a post's header and no body).
//
// Complete means the page reached </html>. Not "ends with </html>": Astro
// puts a page's own <script> after it, and the home page and /glossary build
// that way. A post that writes the tag in prose shows it escaped, as
// &lt;/html&gt;, so text cannot stand in for the real end.
const CLOSES = /<\/html>/i;

/** The paths, of those given, whose HTML stops before </html>. */
export function incompletePages(
	pages: readonly { path: string; html: string }[],
): string[] {
	return pages.filter((p) => !CLOSES.test(p.html)).map((p) => p.path);
}

/**
 * Fails `astro build` when a prerendered page is incomplete, naming each one.
 * A build hook rather than a step in deploy.yml, so every build of the site
 * runs it: CI, the production deploy and pull request previews alike.
 */
export function completePages(): AstroIntegration {
	return {
		name: "onlooker:complete-pages",
		hooks: {
			"astro:build:done": ({ dir, logger }) => {
				const root = fileURLToPath(dir);
				const pages = readdirSync(root, { recursive: true, encoding: "utf8" })
					.filter((f) => f.endsWith(".html"))
					.map((path) => ({
						path,
						html: readFileSync(join(root, path), "utf8"),
					}));
				const cut = incompletePages(pages);
				if (cut.length > 0) {
					throw new Error(
						`${cut.length} page(s) stop before </html>, so a component threw while they rendered: ${cut.join(", ")}`,
					);
				}
				logger.info(`${pages.length} pages reach </html>`);
			},
		},
	};
}
