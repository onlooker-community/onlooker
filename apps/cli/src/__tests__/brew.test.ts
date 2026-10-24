import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brewTrustLines, checkBrewTrust, liveTrustFile } from "../brew";

/** A home directory with nothing in it, and the paths brew could read there. */
function machine() {
	const home = mkdtempSync(join(tmpdir(), "onlooker-brew-"));
	return {
		home,
		dotHomebrew: join(home, ".homebrew", "trust.json"),
		xdg: join(home, ".config"),
		xdgTrust: join(home, ".config", "homebrew", "trust.json"),
	};
}

function writeTrust(path: string, store: Record<string, string[]>): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(store));
}

/** Where a Homebrew install of this CLI resolves to. */
const CELLAR_BIN =
	"/opt/homebrew/Cellar/onlooker/2.10.2/libexec/dist/onlooker.mjs";

// Read off /opt/homebrew/bin/brew (Homebrew 7.0.10), lines 165-173. Each brew
// run reads ONE trust file and never falls back to another, so a trust entry
// in any other file is ignored outright. ONL-65.
describe("liveTrustFile", () => {
	it("is under XDG_CONFIG_HOME when that is set", () => {
		const m = machine();
		expect(liveTrustFile({ XDG_CONFIG_HOME: m.xdg }, m.home)).toEqual({
			path: m.xdgTrust,
			because: "XDG_CONFIG_HOME is set",
		});
	});

	it("is under HOMEBREW_XDG_CONFIG_HOME when only that is set", () => {
		const m = machine();
		const other = join(m.home, "elsewhere");
		expect(liveTrustFile({ HOMEBREW_XDG_CONFIG_HOME: other }, m.home)).toEqual({
			path: join(other, "homebrew", "trust.json"),
			because: "HOMEBREW_XDG_CONFIG_HOME is set",
		});
	});

	it("prefers XDG_CONFIG_HOME over HOMEBREW_XDG_CONFIG_HOME", () => {
		const m = machine();
		expect(
			liveTrustFile(
				{ XDG_CONFIG_HOME: m.xdg, HOMEBREW_XDG_CONFIG_HOME: "/nope" },
				m.home,
			).path,
		).toBe(m.xdgTrust);
	});

	it("is ~/.homebrew/trust.json when neither is set", () => {
		const m = machine();
		expect(liveTrustFile({}, m.home)).toEqual({
			path: m.dotHomebrew,
			because: "XDG_CONFIG_HOME is not set",
		});
	});

	// brew tests `-n`, so an empty value is the same as an unset one.
	it("treats an empty XDG_CONFIG_HOME as unset", () => {
		const m = machine();
		expect(liveTrustFile({ XDG_CONFIG_HOME: "" }, m.home).path).toBe(
			m.dotHomebrew,
		);
	});
});

describe("checkBrewTrust", () => {
	// A source checkout or an npm install never asks brew anything, and a
	// check about brew's trust there would only be noise.
	it("has nothing to say when this CLI was not installed by Homebrew", () => {
		const m = machine();
		expect(
			checkBrewTrust({
				env: {},
				home: m.home,
				binPath: "/Users/someone/src/onlooker/apps/cli/dist/onlooker.mjs",
			}),
		).toEqual({ kind: "not-homebrew" });
	});

	it("is trusted when the live file trusts the tap", () => {
		const m = machine();
		writeTrust(m.xdgTrust, { trustedtaps: ["onlooker-community/tap"] });

		expect(
			checkBrewTrust({
				env: { XDG_CONFIG_HOME: m.xdg },
				home: m.home,
				binPath: CELLAR_BIN,
			}),
		).toMatchObject({
			kind: "trusted",
			file: m.xdgTrust,
			untrustedElsewhere: [],
		});
	});

	// Formula-level trust is enough for brew to upgrade this one formula.
	it("is trusted when the live file trusts just the formula", () => {
		const m = machine();
		writeTrust(m.dotHomebrew, {
			trustedformulae: ["onlooker-community/tap/onlooker"],
		});

		expect(
			checkBrewTrust({ env: {}, home: m.home, binPath: CELLAR_BIN }).kind,
		).toBe("trusted");
	});

	it("is untrusted when no trust file exists at all", () => {
		const m = machine();

		expect(
			checkBrewTrust({ env: {}, home: m.home, binPath: CELLAR_BIN }),
		).toMatchObject({
			kind: "untrusted",
			file: m.dotHomebrew,
			trustedElsewhere: [],
		});
	});

	// The case measured 2026-10-23: 2.10.0 was installed from a shell that
	// read ~/.homebrew, 2.10.1 was upgraded from one that read
	// ~/.config/homebrew, and brew refused a tap that a file on disk plainly
	// trusted.
	it("names the file that does trust the tap when brew reads another", () => {
		const m = machine();
		writeTrust(m.dotHomebrew, { trustedtaps: ["onlooker-community/tap"] });
		writeTrust(m.xdgTrust, { trustedtaps: ["someone/else"] });

		expect(
			checkBrewTrust({
				env: { XDG_CONFIG_HOME: m.xdg },
				home: m.home,
				binPath: CELLAR_BIN,
			}),
		).toMatchObject({
			kind: "untrusted",
			file: m.xdgTrust,
			trustedElsewhere: [m.dotHomebrew],
		});
	});

	// The warning that would have come a day early: trusted where this
	// shell looks, not where a shell without XDG_CONFIG_HOME looks.
	it("notes an existing trust file that would refuse the tap", () => {
		const m = machine();
		writeTrust(m.xdgTrust, { trustedtaps: ["onlooker-community/tap"] });
		writeTrust(m.dotHomebrew, { trustedtaps: ["someone/else"] });

		expect(
			checkBrewTrust({
				env: { XDG_CONFIG_HOME: m.xdg },
				home: m.home,
				binPath: CELLAR_BIN,
			}),
		).toMatchObject({ kind: "trusted", untrustedElsewhere: [m.dotHomebrew] });
	});

	// This is the command run because something is broken, so it reports a
	// bad file rather than throwing.
	it("reports a trust file it cannot read", () => {
		const m = machine();
		mkdirSync(join(m.dotHomebrew, ".."), { recursive: true });
		writeFileSync(m.dotHomebrew, "{ not json");

		expect(
			checkBrewTrust({ env: {}, home: m.home, binPath: CELLAR_BIN }),
		).toMatchObject({ kind: "unreadable", file: m.dotHomebrew });
	});
});

describe("brewTrustLines", () => {
	it("says nothing when this CLI was not installed by Homebrew", () => {
		expect(brewTrustLines({ kind: "not-homebrew" }, "/h")).toEqual([]);
	});

	it("names the live file, with home shortened, when it is trusted", () => {
		const text = brewTrustLines(
			{
				kind: "trusted",
				file: "/h/.config/homebrew/trust.json",
				because: "XDG_CONFIG_HOME is set",
				untrustedElsewhere: [],
			},
			"/h",
		).join("\n");

		expect(text).toMatch(/trusts onlooker-community\/tap/);
		expect(text).toContain("~/.config/homebrew/trust.json");
		expect(text).not.toMatch(/caution/i);
	});

	it("tells someone to run brew trust, and why their earlier one did not count", () => {
		const text = brewTrustLines(
			{
				kind: "untrusted",
				file: "/h/.config/homebrew/trust.json",
				because: "XDG_CONFIG_HOME is set",
				trustedElsewhere: ["/h/.homebrew/trust.json"],
			},
			"/h",
		).join("\n");

		expect(text).toMatch(/brew upgrade will skip onlooker/i);
		expect(text).toContain("because XDG_CONFIG_HOME is set");
		expect(text).toContain("~/.homebrew/trust.json trusts it");
		expect(text).toMatch(/reads only one/i);
		expect(text).toContain("brew trust onlooker-community/tap");
	});

	it("cautions about a trust file another shell would read", () => {
		const text = brewTrustLines(
			{
				kind: "trusted",
				file: "/h/.config/homebrew/trust.json",
				because: "XDG_CONFIG_HOME is set",
				untrustedElsewhere: ["/h/.homebrew/trust.json"],
			},
			"/h",
		).join("\n");

		expect(text).toMatch(/caution/i);
		expect(text).toContain("~/.homebrew/trust.json");
	});
});
