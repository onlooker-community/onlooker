import { describe, expect, it } from "vitest";
import { ApiError } from "../api";
import { CliError, isCrash } from "../errors";

describe("isCrash", () => {
	// A refusal or a dropped connection is the API talking, not a defect in
	// the CLI. Reporting those would fill the project with the network.
	it("never counts an ApiError", () => {
		expect(isCrash(new ApiError({ kind: "transient", message: "503" }))).toBe(
			false,
		);
	});

	// The deliberate messages: a bad config, no token, a corrupt local file.
	// The user can act on each, and each names a local path.
	it("never counts a CliError", () => {
		expect(isCrash(new CliError("cli.json could not be read"))).toBe(false);
	});

	// A permissions problem or a full disk describes the machine, not the CLI.
	it("never counts a system error", () => {
		const error = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});
		expect(isCrash(error)).toBe(false);
	});

	// Some errno names carry a digit: an argument list too long for exec.
	it("never counts a system error whose name has a digit", () => {
		const error = Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
		expect(isCrash(error)).toBe(false);
	});

	it("counts anything else", () => {
		expect(isCrash(new TypeError("cannot read properties of undefined"))).toBe(
			true,
		);
		expect(isCrash(new Error("plain"))).toBe(true);
		expect(isCrash("a thrown string")).toBe(true);
	});

	// A `code` that is not an errno name is not a system error. Without the
	// pattern, any library error with a `code` field would hide a real bug.
	it("counts an error whose code is not an errno name", () => {
		const error = Object.assign(new Error("bad"), { code: "ERR_INVALID_ARG" });
		expect(isCrash(error)).toBe(true);
	});

	it("keeps the message a CliError was given", () => {
		const error = new CliError("No token entered. Nothing was changed.");
		expect(error.message).toBe("No token entered. Nothing was changed.");
		expect(error).toBeInstanceOf(Error);
	});
});
