import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scaffold, weekOf } from "../src/lib/changelog-scaffold";

// pnpm changelog:new [YYYY-MM-DD]: writes this week's draft entry, or the
// week holding the date given. Never overwrites an entry that exists.

function localToday(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const week = weekOf(process.argv[2] ?? localToday());
const file = fileURLToPath(
	new URL(`../src/content/changelog/${week.weekEnd}.mdx`, import.meta.url),
);

try {
	writeFileSync(file, scaffold(week), { flag: "wx" });
} catch (error) {
	if ((error as NodeJS.ErrnoException).code === "EEXIST") {
		console.error(`${file} already exists. Edit it instead.`);
		process.exit(1);
	}
	throw error;
}

console.log(`Wrote ${file} as a draft.`);
console.log(
	"Fill each section or delete it, set the title and summary, then flip draft to false to publish.",
);
