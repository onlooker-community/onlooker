import { describe, expect, it } from "vitest";
import { isValidLabel, remoteLabel, rootLabel } from "../project-label";

// Problem 5: every form git accepts, with and without credentials.
const REMOTES: Array<[string, string | null]> = [
	[
		"git@github.com:onlooker-community/onlooker.git",
		"onlooker-community/onlooker",
	],
	["github.com:onlooker-community/onlooker", "onlooker-community/onlooker"],
	[
		"ssh://git@github.com/onlooker-community/onlooker.git",
		"onlooker-community/onlooker",
	],
	["ssh://git@git.corp.example:2222/team/svc.git", "team/svc"],
	["git+ssh://git@github.com/a/b.git", "a/b"],
	["ssh+git://git@github.com/a/b.git", "a/b"],
	["git://github.com/a/b.git", "a/b"],
	["http://github.com/a/b", "a/b"],
	[
		"https://github.com/onlooker-community/onlooker.git",
		"onlooker-community/onlooker",
	],
	["https://user:tok@git.corp.example:8443/team/svc.git", "team/svc"],
	["https://x-access-token:ghs_abc@github.com/a/b.git/", "a/b"],
	["https://gitlab.com/group/sub/proj.git", "sub/proj"],
	["https://host/a%40b/c.git", null],
	["https://host/onlyone.git", null],
	["https://host/", null],
	["file:///Users/me/src/repo.git", null],
	["/Users/me/src/repo.git", null],
	["../repo", null],
	["C:\\repos\\thing", null],
	["", null],
	// `~user` paths keep the tilde: pinned as derivation 1 sends it.
	["ssh://h/~alice/b.git", "~alice/b"],
	// Not `h:`: a one-letter host is a Windows drive (below), not scp.
	["host:~/repo", "~/repo"],
	["user@host:~/a/b", "a/b"],
	// Bracketed IPv6 scp is not parsed. Null never alternates with a label,
	// so naming it later needs no new derivation.
	["git@[::1]:a/b.git", null],
	// Adversarial: each must name the repo or nothing, never a secret.
	["HTTPS://u:p@h/a/b", "a/b"],
	["https://host/a/b?token=abc", "a/b"],
	["https://host/a/b#frag", "a/b"],
	["ssh://host:/a/b", "a/b"],
	["https://host/a%3Ab/c", null],
	["host:tok@x/b", null],
	["git@github.com:a/b.git \n", "a/b"],
	["https://host/a/b%3Ftoken%3Dx", null],
	["host:a/b.git?token=abc", null],
	["host:a/b#frag", null],
	["https://host/a/B.GIT", "a/B"],
	["https://dev.azure.com/org/proj/_git/repo", "proj/repo"],
	["org@vs-ssh.visualstudio.com:v3/org/proj/repo", "proj/repo"],
	// Sent decoded: the name a person would type, not its encoding.
	["https://host/a%20x/b", "a x/b"],
];

describe("remoteLabel", () => {
	it.each(REMOTES)("%s -> %s", (url, label) => {
		expect(remoteLabel(url)).toBe(label);
	});

	it("never returns a host, port or credential", () => {
		for (const [url] of REMOTES) {
			const label = remoteLabel(url);
			if (label === null) continue;
			expect(label).not.toMatch(/[@:?#]/);
			expect(label).toBe(label.trim());
			expect(label.split("/")).toHaveLength(2);
			for (const secret of [
				"github.com",
				"corp.example",
				"tok",
				"ghs_abc",
				"8443",
				"2222",
				"host",
				"frag",
				"dev.azure.com",
				"visualstudio",
				"_git",
			]) {
				expect(label).not.toContain(secret);
			}
		}
	});
});

describe("rootLabel", () => {
	it("is the folder name", () => {
		expect(rootLabel("/Users/me/src/notes")).toBe("notes");
		expect(rootLabel("/Users/me/src/notes/")).toBe("notes");
	});
	it("is nothing for the filesystem root", () => {
		expect(rootLabel("/")).toBeNull();
	});
	it("is nothing for a name the server would refuse", () => {
		expect(rootLabel("/tmp/a\u202eb")).toBeNull();
	});
});

describe("isValidLabel", () => {
	it("holds the server's rules", () => {
		expect(isValidLabel("a/b")).toBe(true);
		expect(isValidLabel("  ")).toBe(false);
		expect(isValidLabel("a\nb")).toBe(false);
		expect(isValidLabel("é".repeat(101))).toBe(false); // 202 bytes
	});
});
