import { describe, expect, it } from "vitest";
import type { Inventory, Machine } from "../api/machinesApi";
import type { SessionSummary } from "../api/sessionsApi";
import {
	installedOnlookerPlugins,
	reportingMachines,
	silentPlugins,
} from "../lib/installedPlugins";

function machine(over: Partial<Machine>): Machine {
	return {
		id: "m",
		name: "m",
		created_at: "2026-11-01T00:00:00Z",
		last_used_at: null,
		revoked_at: null,
		removed_at: null,
		inventory_at: "2026-11-18T00:00:00Z",
		plugin_count: 1,
		org_id: null,
		...over,
	};
}

function inventory(
	plugins: { id: string; enabled: (boolean | null)[] }[],
): Inventory {
	return {
		schema_version: 1,
		collected_at: "2026-11-18T00:00:00Z",
		project: null,
		plugins: plugins.map((p) => ({
			id: p.id,
			scopes: p.enabled.map((enabled) => ({
				scope: "user",
				version: "1.0.0",
				git_commit_sha: null,
				installed_at: null,
				last_updated: null,
				enabled,
			})),
		})),
	};
}

function session(over: Partial<SessionSummary>): SessionSummary {
	return {
		session_id: "s",
		machine_id: "m1",
		started_at: "2026-11-18T10:00:00Z",
		ended_at: "2026-11-18T11:00:00Z",
		event_count: 1,
		counts_by_prefix: {},
		counts_by_type: {},
		counts_by_project: {},
		plugins: [],
		prompts: 1,
		compactions: 0,
		subordinate: null,
		...over,
	};
}

describe("reportingMachines", () => {
	it("keeps machines that are live and have reported an inventory", () => {
		const kept = reportingMachines([
			machine({ id: "ok" }),
			machine({ id: "revoked", revoked_at: "2026-11-02T00:00:00Z" }),
			machine({ id: "removed", removed_at: "2026-11-02T00:00:00Z" }),
			machine({ id: "never", inventory_at: null }),
		]);

		expect(kept.map((m) => m.id)).toEqual(["ok"]);
	});
});

describe("installedOnlookerPlugins", () => {
	it("names Onlooker plugins by the part before the @, once each", () => {
		expect(
			installedOnlookerPlugins([
				inventory([
					{ id: "historian@onlooker-community", enabled: [true] },
					{ id: "superpowers@superpowers-dev", enabled: [true] },
				]),
				inventory([{ id: "historian@onlooker-community", enabled: [true] }]),
				inventory([{ id: "counsel@onlooker-community", enabled: [true] }]),
			]),
		).toEqual(["counsel", "historian"]);
	});

	// Null is the CLI saying it could not tell; dropping it would hide a plugin
	// that may well be on.
	it("counts a plugin enabled in any scope, or unknowably enabled", () => {
		expect(
			installedOnlookerPlugins([
				inventory([
					{ id: "customs@onlooker-community", enabled: [false, null] },
					{ id: "warden@onlooker-community", enabled: [false] },
				]),
			]),
		).toEqual(["customs"]);
	});
});

describe("silentPlugins", () => {
	it("names installed plugins no session in the week heard from", () => {
		expect(
			silentPlugins(
				["counsel", "historian", "warden"],
				[
					session({ counts_by_prefix: { historian: 3, tool: 9 } }),
					session({ plugins: ["warden"] }),
				],
			),
		).toEqual(["counsel"]);
	});

	// ecosystem is infrastructure: the schema has no event of its own for it,
	// so "no events this week" would be true every week and say nothing.
	it("never names a plugin the schema has no events for", () => {
		expect(silentPlugins(["ecosystem", "counsel"], [])).toEqual(["counsel"]);
	});
});
