import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getMachineInventory,
	pluginCount,
	putMachineInventory,
} from "./machine-inventory.js";
import {
	createMachineToken,
	listMachineTokens,
	revokeMachineToken,
} from "./machine-tokens.js";
import { createUser } from "./queries.js";

const db = () => env.DB;

const doc = (ids: string[]) =>
	JSON.stringify({
		schema_version: 1,
		collected_at: "2026-09-11T00:00:00.000Z",
		project: null,
		plugins: ids.map((id) => ({ id, scopes: [] })),
	});

let userId: string;

beforeEach(async () => {
	await db().prepare("DELETE FROM machine_tokens").run();
	await db().prepare("DELETE FROM sessions").run();
	await db().prepare("DELETE FROM users").run();
	const user = await createUser(db(), "m@example.com", "hash", "Ada");
	userId = user.id;
});

describe("putMachineInventory", () => {
	// Re-running sync must be free. Accumulation is what the retired CLI's
	// buffer did, and it filled a database forever behind a dead endpoint.
	it("replaces the document rather than accumulating", async () => {
		const m = await createMachineToken(db(), userId, "laptop");

		await putMachineInventory(db(), m.id, doc([]), "2026-09-11T00:00:00.000Z");
		await putMachineInventory(
			db(),
			m.id,
			doc(["a", "b"]),
			"2026-09-11T01:00:00.000Z",
		);

		const got = await getMachineInventory(db(), userId, m.id);
		expect(JSON.parse(got?.inventory ?? "{}").plugins).toHaveLength(2);
		expect(got?.inventory_at).toBe("2026-09-11T01:00:00.000Z");
	});

	it("stores the document byte for byte", async () => {
		const m = await createMachineToken(db(), userId, "laptop");
		const sent = doc(["librarian@onlooker-community"]);

		await putMachineInventory(db(), m.id, sent, "2026-09-11T00:00:00.000Z");

		expect((await getMachineInventory(db(), userId, m.id))?.inventory).toBe(sent);
	});

	// A token that could write another machine's row would make the page
	// unable to say who reported what.
	it("writes only the machine it was given", async () => {
		const reporter = await createMachineToken(db(), userId, "laptop");
		const bystander = await createMachineToken(db(), userId, "desktop");

		await putMachineInventory(
			db(),
			reporter.id,
			doc(["a"]),
			"2026-09-11T00:00:00.000Z",
		);

		expect(await getMachineInventory(db(), userId, bystander.id)).toBeNull();
	});
});

describe("getMachineInventory", () => {
	it("will not hand a machine's inventory to another account", async () => {
		const other = await createUser(db(), "b@example.com", "hash", "Bob");
		const m = await createMachineToken(db(), userId, "laptop");
		await putMachineInventory(db(), m.id, doc(["a"]), "2026-09-11T00:00:00.000Z");

		expect(await getMachineInventory(db(), other.id, m.id)).toBeNull();
	});

	it("reports a never-reported machine as null", async () => {
		const m = await createMachineToken(db(), userId, "laptop");

		expect(await getMachineInventory(db(), userId, m.id)).toBeNull();
	});

	it("stops answering for a revoked machine", async () => {
		const m = await createMachineToken(db(), userId, "lost laptop");
		await putMachineInventory(db(), m.id, doc(["a"]), "2026-09-11T00:00:00.000Z");

		await revokeMachineToken(db(), userId, m.id);

		expect(await getMachineInventory(db(), userId, m.id)).toBeNull();
	});
});

describe("listMachineTokens inventory summary", () => {
	it("carries the count and the timestamp, never the document", async () => {
		const m = await createMachineToken(db(), userId, "laptop");
		await putMachineInventory(
			db(),
			m.id,
			doc(["a", "b", "c"]),
			"2026-09-11T00:00:00.000Z",
		);

		const [row] = await listMachineTokens(db(), userId);

		expect(row.plugin_count).toBe(3);
		expect(row.inventory_at).toBe("2026-09-11T00:00:00.000Z");
		// The split exists so a list of machines does not carry every
		// machine's whole inventory. `scopes` appears only inside a document.
		expect(JSON.stringify(row)).not.toContain("scopes");
	});

	// Zero plugins would be a claim about the machine. Null is a claim about
	// what we know, which is nothing.
	it("distinguishes never reported from an empty inventory", async () => {
		const never = await createMachineToken(db(), userId, "never");
		const empty = await createMachineToken(db(), userId, "empty");
		await putMachineInventory(db(), empty.id, doc([]), "2026-09-11T00:00:00.000Z");

		const rows = await listMachineTokens(db(), userId);
		const neverRow = rows.find((r) => r.id === never.id);
		const emptyRow = rows.find((r) => r.id === empty.id);

		expect(neverRow?.plugin_count).toBeNull();
		expect(neverRow?.inventory_at).toBeNull();
		expect(emptyRow?.plugin_count).toBe(0);
		expect(emptyRow?.inventory_at).not.toBeNull();
	});
});

describe("pluginCount", () => {
	it("counts the plugins a document names", () => {
		expect(pluginCount(doc(["a", "b"]))).toBe(2);
	});

	it("is null for nothing stored", () => {
		expect(pluginCount(null)).toBeNull();
	});

	// A document that will not parse is still a report - it just is not one
	// this summary can describe, and zero would be a lie about the machine.
	it("is null rather than zero for a document it cannot read", () => {
		expect(pluginCount("{ not json")).toBeNull();
		expect(pluginCount(JSON.stringify({ plugins: "nope" }))).toBeNull();
	});
});
