import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The site's CSS as the tests read it: every .css file under src, and every
// <style> block in an .astro file, with comments stripped.

const SRC = fileURLToPath(new URL("../", import.meta.url));

export type Rule = { selector: string; body: string; media: string | null };

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__tests__" ? [] : sources(path);
		}
		return /\.(css|astro)$/.test(entry.name) ? [path] : [];
	});
}

function stylesheet(path: string): string {
	const text = readFileSync(path, "utf8");
	const css = path.endsWith(".astro")
		? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
				.map((m) => m[1])
				.join("\n")
		: text;
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Top-level rules, and the rules inside @media blocks. Other at-rules are skipped. */
export function rules(css: string, media: string | null = null): Rule[] {
	const out: Rule[] = [];
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf("{", i);
		if (open < 0) break;
		let depth = 0;
		let close = open;
		for (; close < css.length; close++) {
			if (css[close] === "{") depth++;
			if (css[close] === "}" && --depth === 0) break;
		}
		const prelude = css.slice(i, open).trim().replace(/\s+/g, " ");
		const body = css.slice(open + 1, close);
		if (prelude.startsWith("@media")) out.push(...rules(body, prelude));
		else if (!prelude.startsWith("@"))
			out.push({ selector: prelude, body, media });
		i = close + 1;
	}
	return out;
}

export function declared(body: string, property: string): string | undefined {
	return new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+)`)
		.exec(body)?.[1]
		.trim();
}

/** Every stylesheet under src, named by its path relative to src. */
export const stylesheets = sources(SRC).map((path) => ({
	name: relative(SRC, path),
	rules: rules(stylesheet(path)),
}));
