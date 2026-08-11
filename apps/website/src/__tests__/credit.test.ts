import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync(
	new URL("../layouts/Layout.astro", import.meta.url),
	"utf8",
);

// CC BY 4.0 requires the credit to travel with the work. ATTRIBUTION.md does
// not satisfy it - nobody renders that file. This layout wraps every page, so
// the credit living here is what makes the site compliant.
describe("icon attribution", () => {
	it("names the author in the shared layout", () => {
		expect(layout).toContain("Crusenho Agus Hennihuno");
	});

	it("links the license", () => {
		expect(layout).toContain("creativecommons.org/licenses/by/4.0");
	});
});
