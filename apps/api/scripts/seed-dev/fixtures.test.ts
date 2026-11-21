import { ZLesson } from "@onlooker-community/lesson-contract";
import { describe, expect, it } from "vitest";
import {
	invites,
	LABELS,
	type LessonEvent,
	lessonTimeline,
	MEMBERSHIPS,
	machines,
	ORG,
	SEED_DOMAIN,
	sessions,
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

describe("seed sessions", () => {
	const all = sessions(NOW);
	const week = all.filter(
		(s) =>
			new Date(s.body.started_at) > new Date(NOW.getTime() - 7 * 86_400_000),
	);

	it("puts about 20 sessions in the last 7 days, with one quiet day", () => {
		expect(week.length).toBeGreaterThanOrEqual(18);
		const days = new Set(week.map((s) => s.body.started_at.slice(0, 10)));
		expect(days.has("2026-11-17")).toBe(false);
	});

	it("reaches back past the week, to the removed machine's last session", () => {
		const oldest = all.map((s) => s.body.started_at).sort()[0];
		expect(oldest.slice(0, 10)).toBe("2026-10-06");
	});

	it("leaves exactly one session running", () => {
		expect(all.filter((s) => s.body.ended_at === null)).toHaveLength(1);
	});

	// Each kind of row Home's Plugins panel and the Sessions rows draw.
	it("covers every kind of plugin activity", () => {
		const types = week.flatMap((s) => Object.keys(s.body.counts_by_type ?? {}));
		expect(types).toEqual(
			expect.arrayContaining([
				"historian.retrieval.surfaced", // produced
				"historian.embedder.failed", // failed beside output
				"governor.ledger.write_failed", // failed only
				"curator.scan.complete", // found nothing
				"tribunal.gate.skipped", // skipped
				"futureplugin.signal.raised", // unclassified
				"onlooker.artifact.ready", // archivist, heard only through plugins
			]),
		);
		expect(week.some((s) => s.body.counts_by_type === undefined)).toBe(true);
		expect(week.some((s) => s.body.plugins.includes("archivist"))).toBe(true);
	});

	it("derives each session's prefixes and event count from its types", () => {
		for (const { body } of all) {
			if (!body.counts_by_type) continue;
			const sum = Object.values(body.counts_by_type).reduce((a, b) => a + b, 0);
			expect(body.event_count).toBe(sum);
			expect(
				Object.values(body.counts_by_prefix).reduce((a, b) => a + b, 0),
			).toBe(sum);
		}
	});

	it("keeps every event type in the shape ingest accepts", () => {
		const shape = /^(?=.{1,64}$)[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;
		for (const { body } of all)
			for (const type of Object.keys(body.counts_by_type ?? {}))
				expect(type).toMatch(shape);
	});

	it("spans two repositories in one session", () => {
		expect(
			all.some((s) => Object.keys(s.body.counts_by_project).length === 2),
		).toBe(true);
	});

	it("gives every session a unique id", () => {
		const ids = all.map((s) => s.body.session_id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("seed lessons", () => {
	const timeline = lessonTimeline(NOW);
	const pushes = timeline.flatMap((e) => (e.kind === "push" ? [e] : []));
	const changes = timeline.flatMap((e) => (e.kind === "status" ? [e] : []));
	const machineOwner = new Map(machines(NOW).map((m) => [m.id, m.owner]));

	it("pushes only lessons the contract accepts", () => {
		for (const { lesson } of pushes)
			expect(ZLesson.safeParse(lesson).success).toBe(true);
	});

	it("pushes every lesson active, and changes status only through the route", () => {
		for (const { lesson } of pushes) {
			expect(lesson.status).toBe("active");
			expect(lesson.superseded_by).toBeNull();
		}
	});

	it("ends with dev's lessons in every status and every visibility", () => {
		const finalStatus = new Map(pushes.map((p) => [p.lesson.id, "active"]));
		for (const c of changes) finalStatus.set(c.lessonId, c.status);
		const devs = pushes.filter((p) => machineOwner.get(p.machine) === "dev");
		expect(new Set(devs.map((p) => finalStatus.get(p.lesson.id)))).toEqual(
			new Set(["active", "refuted", "superseded", "retracted"]),
		);
		expect(new Set(devs.map((p) => p.lesson.visibility))).toEqual(
			new Set(["private", "org", "public"]),
		);
	});

	it("supersedes a lesson with one already pushed", () => {
		const superseded = changes.find((c) => c.status === "superseded");
		const ids = pushes.map((p) => p.lesson.id);
		expect(superseded?.supersededBy).not.toBeNull();
		const replacementPushed = timeline.findIndex(
			(e) => e.kind === "push" && e.lesson.id === superseded?.supersededBy,
		);
		expect(replacementPushed).toBeGreaterThanOrEqual(0);
		expect(replacementPushed).toBeLessThan(
			timeline.indexOf(superseded as LessonEvent),
		);
		expect(ids).toContain(superseded?.supersededBy);
	});

	it("pushes org lessons only from machines bound to the org", () => {
		const orgMachines = new Set(
			machines(NOW)
				.filter((m) => m.orgId)
				.map((m) => m.id),
		);
		for (const p of pushes)
			if (p.lesson.visibility === "org")
				expect(orgMachines.has(p.machine)).toBe(true);
	});

	it("gives every public lesson a unanimous jury", () => {
		for (const { lesson } of pushes)
			if (lesson.visibility === "public")
				expect(lesson.consensus.agreed).toBe(lesson.consensus.judges);
	});

	it("has lessons from all three authors", () => {
		expect(new Set(pushes.map((p) => machineOwner.get(p.machine)))).toEqual(
			new Set(["dev", "ada", "sam"]),
		);
	});

	it("runs in time order, over two weeks, with one status change per lesson at most", () => {
		const times = timeline.map((e) => e.at);
		expect([...times].sort()).toEqual(times);
		expect(new Date(times[0]) < new Date(NOW.getTime() - 12 * 86_400_000)).toBe(
			true,
		);
		const changed = changes.map((c) => c.lessonId);
		expect(new Set(changed).size).toBe(changed.length);
	});

	it("never changes a lesson before it is pushed", () => {
		for (const c of changes) {
			const pushedAt = pushes.find((p) => p.lesson.id === c.lessonId)?.at ?? "";
			expect(pushedAt < c.at).toBe(true);
		}
	});
});
