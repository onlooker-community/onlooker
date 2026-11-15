import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, LabelUpload } from "../api";
import { readConfig, readStoredConfig, writeConfig } from "../config";
import type { Candidate } from "../label-candidates";
import type { Resolved } from "../project-key";
import { planLabels, reportProjectLabels } from "../report-labels";

const optedIn = (): NodeJS.ProcessEnv => {
	const env = {
		ONLOOKER_DIR: mkdtempSync(join(tmpdir(), "onlooker-report-labels-")),
	};
	writeConfig(
		{
			apiBaseUrl: "https://api.onlooker.dev",
			machineToken: "tok",
			projectLabels: true,
		},
		env,
	);
	return env;
};

/** What `project-labels off` writes before it asks the API to delete. */
const turnOff = (env: NodeJS.ProcessEnv) =>
	writeConfig({ ...readStoredConfig(env), projectLabels: false }, env);

describe("reportProjectLabels never throws", () => {
	const client = {} as ApiClient;

	it("returns a note when deriving a label throws", async () => {
		const note = await reportProjectLabels(
			client,
			optedIn(),
			[{ key: "6a7678979e31", basis: "remote", dirs: ["/a"] }],
			{
				upload: true,
				resolve: () => {
					throw new Error("EACCES: git exploded");
				},
			},
		);
		expect(note).toBe("Project labels not sent: EACCES: git exploded");
	});

	it("returns a note when cli.json cannot be read", async () => {
		const env = optedIn();
		writeFileSync(join(env.ONLOOKER_DIR as string, "cli.json"), "{not json");
		const note = await reportProjectLabels(client, env, [], { upload: true });
		expect(note).toMatch(/^Project labels not sent: /);
	});
});

const K = "6a7678979e31";
const table =
	(map: Record<string, Resolved>) =>
	(dir: string): Resolved =>
		map[dir] ?? { kind: "none", why: "missing" };

/** `count` root keys, each verifying in its own directory. */
function roots(count: number): {
	candidates: Candidate[];
	resolve: (dir: string) => Resolved;
} {
	const map: Record<string, Resolved> = {};
	const candidates: Candidate[] = [];
	for (let i = 0; i < count; i++) {
		const key = i.toString(16).padStart(12, "0");
		map[`/r/p${i}`] = { kind: "root", key, root: `/r/p${i}` };
		candidates.push({ key, basis: "root", dirs: [`/r/p${i}`] });
	}
	return { candidates, resolve: table(map) };
}

const putting = (
	answer: (labels: LabelUpload[]) => unknown = (labels) => ({
		stored: labels.length,
		skipped: 0,
	}),
) => {
	const putProjectLabels = vi.fn(async (labels: LabelUpload[]) =>
		answer(labels),
	);
	return {
		client: { putProjectLabels } as unknown as ApiClient,
		putProjectLabels,
	};
};

describe("reportProjectLabels", () => {
	it("deletes a pending deletion even when the sessions were not reported", async () => {
		const env = optedIn();
		writeConfig(
			{
				...readStoredConfig(env),
				projectLabels: false,
				projectLabelsPending: "delete",
			},
			env,
		);
		const calls: string[] = [];
		const fetchImpl = (async (input: string | URL | Request, init) => {
			calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
			return new Response(JSON.stringify({ deleted: 2 }), { status: 200 });
		}) as typeof fetch;
		await reportProjectLabels({} as ApiClient, env, [], {
			upload: false,
			fetchImpl,
		});
		expect(calls).toEqual(["DELETE /machine/project-labels"]);
		expect(readConfig(env).projectLabelsPending).toBeUndefined();
	});

	it("uploads nothing when the sessions were not reported", async () => {
		const { client, putProjectLabels } = putting();
		const { candidates, resolve } = roots(1);
		const note = await reportProjectLabels(client, optedIn(), candidates, {
			upload: false,
			resolve,
		});
		expect(putProjectLabels).not.toHaveBeenCalled();
		expect(note).toBeNull();
	});

	// `off` while git runs: the choice on disk is newer than the one read.
	it("sends nothing when turned off before the PUT", async () => {
		const env = optedIn();
		const { client, putProjectLabels } = putting();
		const { candidates, resolve } = roots(1);
		// Stubbed so a regression cannot reach the real API.
		const fetchImpl = vi.fn(
			async () => new Response("{}", { status: 503 }),
		) as unknown as typeof fetch;
		await reportProjectLabels(client, env, candidates, {
			upload: true,
			fetchImpl,
			resolve: (dir) => {
				turnOff(env);
				return resolve(dir);
			},
		});
		expect(putProjectLabels).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	// `off` while the PUT is in flight: its DELETE may have landed first, so
	// what the PUT stored is deleted again.
	it("deletes what it sent when turned off during the PUT", async () => {
		const env = optedIn();
		const { client } = putting((labels) => {
			turnOff(env);
			return { stored: labels.length, skipped: 0 };
		});
		const calls: string[] = [];
		const fetchImpl = (async (input: string | URL | Request, init) => {
			calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
			return new Response(JSON.stringify({ deleted: 1 }), { status: 200 });
		}) as typeof fetch;
		const { candidates, resolve } = roots(1);
		const note = await reportProjectLabels(client, env, candidates, {
			upload: true,
			fetchImpl,
			resolve,
		});
		expect(calls).toEqual(["DELETE /machine/project-labels"]);
		expect(note).toMatch(/turned off/);
		expect(note).toMatch(/Deleted 1 name/);
	});

	it("leaves the deletion pending when the follow-up DELETE fails", async () => {
		const env = optedIn();
		const { client } = putting((labels) => {
			turnOff(env);
			return { stored: labels.length, skipped: 0 };
		});
		const fetchImpl = (async () =>
			new Response("{}", { status: 503 })) as typeof fetch;
		const { candidates, resolve } = roots(1);
		const note = await reportProjectLabels(client, env, candidates, {
			upload: true,
			fetchImpl,
			resolve,
		});
		expect(readConfig(env).projectLabelsPending).toBe("delete");
		expect(note).toMatch(/pending/i);
	});

	it("sends at most 500 labels, in candidate order, and says how many waited", async () => {
		const { client, putProjectLabels } = putting();
		const { candidates, resolve } = roots(503);
		const note = await reportProjectLabels(client, optedIn(), candidates, {
			upload: true,
			resolve,
		});
		const sent = putProjectLabels.mock.calls[0]?.[0] ?? [];
		expect(sent).toHaveLength(500);
		expect(sent.map((l) => l.project_key)).toEqual(
			candidates.slice(0, 500).map((c) => c.key),
		);
		expect(note).toBe("Project labels: 500 sent, 3 held back (500 per sync)");
	});

	it("says so when the PUT answers without counts", async () => {
		const { client } = putting(() => ({}));
		const { candidates, resolve } = roots(1);
		const note = await reportProjectLabels(client, optedIn(), candidates, {
			upload: true,
			resolve,
		});
		expect(note).toBe("Project labels not sent: unexpected response");
	});

	it("counts keys the server has no session for", async () => {
		const { client } = putting(() => ({ stored: 1, skipped: 1 }));
		const { candidates, resolve } = roots(2);
		const note = await reportProjectLabels(client, optedIn(), candidates, {
			upload: true,
			resolve,
		});
		expect(note).toBe("Project labels: 1 sent, 1 skipped (not reported: 1)");
	});
});

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
		expect(plan).toEqual({ labels: [], skipped: { "key changed": 1 } });
	});

	it("skips a key whose basis no longer matches", () => {
		const plan = planLabels(
			[{ key: K, basis: "root", dirs: ["/a"] }],
			table({
				"/a": { kind: "remote", key: K, url: "git@github.com:x/y.git" },
			}),
		);
		expect(plan).toEqual({ labels: [], skipped: { "key changed": 1 } });
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

	// Each directory is up to three git runs, so a key seen in many places
	// must not stall the sync.
	it("tries at most five directories per key, newest first", () => {
		const dirs = ["/1", "/2", "/3", "/4", "/5", "/6"];
		const tried: string[] = [];
		const plan = planLabels([{ key: K, basis: "root", dirs }], (dir) => {
			tried.push(dir);
			return table({ "/6": { kind: "root", key: K, root: "/6" } })(dir);
		});
		expect(tried).toEqual(dirs.slice(0, 5));
		expect(plan).toEqual({ labels: [], skipped: { "directory gone": 1 } });
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
