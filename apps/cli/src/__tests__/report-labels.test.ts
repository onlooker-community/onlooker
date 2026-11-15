import { describe, expect, it } from "vitest";
import type { Resolved } from "../project-key";
import { planLabels } from "../report-labels";

const K = "6a7678979e31";
const table =
	(map: Record<string, Resolved>) =>
	(dir: string): Resolved =>
		map[dir] ?? { kind: "none", why: "missing" };

describe("planLabels", () => {
	it("labels a remote key whose recomputed key matches", () => {
		const plan = planLabels(
			[{ key: K, basis: "remote", dirs: ["/a"] }],
			table({
				"/a": {
					kind: "remote",
					key: K,
					url: "git@github.com:onlooker-community/onlooker.git",
				},
			}),
		);
		expect(plan).toEqual({
			labels: [
				{
					project_key: K,
					basis: "remote",
					label: "onlooker-community/onlooker",
				},
			],
			skipped: {},
		});
	});

	// The verify step: a remote changed since the session must not be named
	// after the new remote.
	it("skips a key whose directory now resolves to another key", () => {
		const plan = planLabels(
			[{ key: K, basis: "remote", dirs: ["/a"] }],
			table({
				"/a": {
					kind: "remote",
					key: "ffffffffffff",
					url: "git@github.com:x/y.git",
				},
			}),
		);
		expect(plan).toEqual({ labels: [], skipped: { "remote changed": 1 } });
	});

	it("skips a key whose basis no longer matches", () => {
		const plan = planLabels(
			[{ key: K, basis: "root", dirs: ["/a"] }],
			table({
				"/a": { kind: "remote", key: K, url: "git@github.com:x/y.git" },
			}),
		);
		expect(plan.labels).toEqual([]);
	});

	it("falls back to an older directory when the newest is gone", () => {
		const plan = planLabels(
			[{ key: K, basis: "root", dirs: ["/gone", "/src/notes"] }],
			table({ "/src/notes": { kind: "root", key: K, root: "/src/notes" } }),
		);
		expect(plan.labels).toEqual([
			{ project_key: K, basis: "root", label: "notes" },
		]);
		expect(plan.skipped).toEqual({});
	});

	it("counts a key with every directory gone once", () => {
		const plan = planLabels(
			[{ key: K, basis: "root", dirs: ["/x", "/y"] }],
			table({}),
		);
		expect(plan.skipped).toEqual({ "directory gone": 1 });
	});

	it("skips a local remote that has no name to send", () => {
		const plan = planLabels(
			[{ key: K, basis: "remote", dirs: ["/a"] }],
			table({
				"/a": { kind: "remote", key: K, url: "/Users/me/bare.git" },
			}),
		);
		expect(plan.skipped).toEqual({ "no name": 1 });
	});
});
