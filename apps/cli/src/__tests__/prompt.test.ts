import { createInterface } from "node:readline";
import { createInterface as createPromisesInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createPromptInterface, suppressEcho } from "../prompt";

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
		expect(suppressEcho(h.rl, "Token: ")).toBe(true);
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
			suppressEcho(
				rl as unknown as ReturnType<typeof createInterface>,
				"Token: ",
			),
		).toBe(false);
		rl.close();
	});

	// The wiring test, and the only one here that would survive `prompt.ts`
	// changing its import. Every other test in this file hands `suppressEcho` an
	// interface the *test* built, so all four stay green when `prompt.ts` imports
	// `node:readline/promises` and the token goes to the screen in clear text -
	// measured, 4/4 passing against that exact regression. This one asks the
	// module for the interface `promptForToken` itself uses, so the assertion is
	// about production wiring rather than about the test's own imports.
	it("builds an interface that can actually suppress echo", () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const rl = createPromptInterface(input, output);
		try {
			expect(suppressEcho(rl, "Token: ")).toBe(true);
		} finally {
			rl.close();
		}
	});

	// The 2.0.0 bug, in the shape that would have caught it. Readline clears the
	// line before a full refresh, and that clear bypasses this hook - so a hook
	// that swallows everything erases the prompt along with the typed text, and
	// `onlooker link` sits there looking like it is doing nothing. Asserting the
	// prompt is *still drawn* is the difference between hiding a credential and
	// hiding the fact that the command wants one.
	it("redraws the prompt that readline's clear removes", () => {
		const written: string[] = [];
		const fake = {
			_writeToOutput: () => {},
		} as unknown as ReturnType<typeof createInterface>;
		const spy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((chunk: string | Uint8Array) => {
				written.push(String(chunk));
				return true;
			});
		try {
			expect(suppressEcho(fake, "Token: ")).toBe(true);
			const hook = (fake as unknown as { _writeToOutput: (s: string) => void })
				._writeToOutput;
			// A full refresh: prompt plus what has been typed so far.
			hook("Token: hunter2");
			// A per-keystroke echo, which must stay hidden.
			hook("h");
		} finally {
			spy.mockRestore();
		}
		expect(written).toEqual(["Token: "]);
	});
});
