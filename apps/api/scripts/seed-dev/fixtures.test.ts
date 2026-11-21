import { describe, expect, it } from "vitest";
import {
	invites,
	LABELS,
	MEMBERSHIPS,
	machines,
	ORG,
	SEED_DOMAIN,
	USERS,
} from "./fixtures";

const NOW = new Date("2026-11-20T15:00:00.000Z");

describe("seed accounts", () => {
	it("keeps every account on the seed domain, lowercased", () => {
		for (const user of Object.values(USERS)) {
			expect(user.email.endsWith(`@${SEED_DOMAIN}`)).toBe(true);
			expect(user.email).toBe(user.email.toLowerCase());
			expect(user.id.startsWith("seed-")).toBe(true);
		}
	});

	it("gives the org an owner and one member, and leaves sam out", () => {
		expect(ORG.id.startsWith("seed-")).toBe(true);
		expect(MEMBERSHIPS.map((m) => [m.user, m.role])).toEqual([
			["dev", "owner"],
			["ada", "member"],
		]);
	});

	it("has one pending invite, to sam, and one expired invite", () => {
		const [pending, expired] = invites(NOW);
		expect(pending.email).toBe(USERS.sam.email);
		expect(new Date(pending.expiresAt) > NOW).toBe(true);
		expect(new Date(expired.expiresAt) < NOW).toBe(true);
	});
});

describe("seed machines", () => {
	const all = machines(NOW);
	const byId = new Map(all.map((m) => [m.id, m]));

	it("covers every machine state dev's Machines page shows", () => {
		const devStates = all.filter((m) => m.owner === "dev").map((m) => m.state);
		expect(new Set(devStates)).toEqual(
			new Set(["live", "never-used", "revoked", "removed"]),
		);
	});

	it("binds dev's laptop and ada's machine to the org, and nothing else", () => {
		expect(all.filter((m) => m.orgId === ORG.id).map((m) => m.id)).toEqual([
			"seed-laptop",
			"seed-ada-machine",
		]);
	});

	it("gives the never-used machine no inventory and no use", () => {
		const spare = byId.get("seed-spare");
		expect(spare?.inventory).toBeNull();
		expect(spare?.lastUsedHoursAgo).toBeNull();
	});

	// Every branch of Home's silent line: heard, silent, never-listed
	// ecosystem, disabled everywhere, enabled-unknowable, another marketplace.
	it("reports inventories that reach every branch of the silent line", () => {
		const ids = byId.get("seed-desktop")?.inventory?.plugins.map((p) => ({
			id: p.id,
			enabled: p.scopes.map((s) => s.enabled),
		}));
		expect(ids).toEqual(
			expect.arrayContaining([
				{ id: "counsel@onlooker-community", enabled: [true] },
				{ id: "customs@onlooker-community", enabled: [null] },
				{ id: "warden@onlooker-community", enabled: [false, false] },
				{ id: "ecosystem@onlooker-community", enabled: [true] },
				{ id: "superpowers@superpowers-dev", enabled: [true] },
			]),
		);
	});

	it("dates everything from now", () => {
		const later = new Date("2026-12-01T15:00:00.000Z");
		expect(invites(later)[0].expiresAt).not.toBe(invites(NOW)[0].expiresAt);
		expect(machines(later)[0].inventory?.collected_at).not.toBe(
			machines(NOW)[0].inventory?.collected_at,
		);
	});
});

describe("seed labels", () => {
	it("names one root key differently on each of two machines", () => {
		const scratch = LABELS.filter((l) => l.label.startsWith("scratch on"));
		expect(scratch.map((l) => l.machineId)).toEqual([
			"seed-desktop",
			"seed-laptop",
		]);
	});

	it("leaves remote keys unscoped", () => {
		const onlooker = LABELS.filter((l) => l.label === "onlooker");
		expect(onlooker.map((l) => l.machineId)).toEqual(["", ""]);
	});
});
