import { createInterface } from "node:readline";
import { createInterface as createPromisesInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { suppressEcho } from "../prompt";

/**
 * A readline interface over two in-memory streams.
 *
 * `terminal: true` is not decoration. Readline only echoes what is typed when
 * it believes it is driving a terminal, so without it every assertion below
 * would pass against a completely broken implementation.
 */
function harness(create: typeof createInterface) {
	const input = new PassThrough();
	const output = new PassThrough();
	let seen = "";
	output.on("data", (chunk) => {
		seen += String(chunk);
	});
	const rl = create({ input, output, terminal: true });
	const ask = () =>
		new Promise<string>((resolve) => {
			rl.question("", resolve);
			input.write("hunter2\n");
		});
	return { rl, ask, seen: () => seen };
}

describe("suppressEcho", () => {
	// The control. If typed characters do not reach the output without the
	// override, the tests below prove nothing.
	it("readline echoes what is typed when nothing suppresses it", async () => {
		const h = harness(createInterface);
		expect(await h.ask()).toBe("hunter2");
		h.rl.close();
		expect(h.seen()).toContain("hunter2");
	});

	it("keeps typed characters off the output", async () => {
		const h = harness(createInterface);
		expect(suppressEcho(h.rl)).toBe(true);
		expect(await h.ask()).toBe("hunter2");
		h.rl.close();
		expect(h.seen()).not.toContain("hunter2");
	});

	// The regression guard. `node:readline/promises` builds an Interface with no
	// `_writeToOutput` at all, so an override assigned to it is never consulted
	// and the credential goes to the screen. Reporting false is what turns that
	// into a warning the user can act on instead of a silent leak.
	it("reports failure on an interface that has no such hook", () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const rl = createPromisesInterface({ input, output, terminal: true });
		expect(
			suppressEcho(rl as unknown as ReturnType<typeof createInterface>),
		).toBe(false);
		rl.close();
	});
});
