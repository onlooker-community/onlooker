import { describe, expect, it } from "vitest";
import { pluginActivity } from "../lib/pluginActivity";

describe("pluginActivity", () => {
	// A session synced by a CLI older than 2.12.0 reported prefixes only. Null
	// is what tells the row to fall back to them rather than say "nothing ran".
	it("is null when the session carried no per-type counts", () => {
		expect(pluginActivity({}, 3)).toBeNull();
	});

	it("counts only output events toward what a plugin produced", () => {
		const activity = pluginActivity(
			{
				"historian.retrieval.surfaced": 3,
				"historian.retrieval.started": 5,
				"historian.retrieval.complete": 5,
				"bursar.session.recorded": 2,
			},
			3,
		);

		expect(activity?.produced.shown).toBe("3 historian · 2 bursar");
	});

	// The scan ran twice and found nothing: that is the sentence this whole
	// feature exists to be able to say.
	it("names a plugin that only started and completed as idle", () => {
		const activity = pluginActivity(
			{ "curator.scan.started": 2, "curator.scan.complete": 2 },
			3,
		);

		expect(activity?.produced.shown).toBe("");
		expect(activity?.idle).toEqual(["curator"]);
		expect(activity?.skipped).toEqual([]);
	});

	it("names a plugin that skipped and produced nothing as skipped, not idle", () => {
		const activity = pluginActivity(
			{ "scribe.distill.skipped": 1, "librarian.scan.complete": 1 },
			3,
		);

		expect(activity?.skipped).toEqual(["scribe"]);
		expect(activity?.idle).toEqual(["librarian"]);
	});

	// Output is the stronger statement, so a plugin is named once, there.
	it("does not also call a plugin idle or skipped once it produced", () => {
		const activity = pluginActivity(
			{
				"tribunal.gate.passed": 1,
				"tribunal.gate.skipped": 4,
				"tribunal.session.start": 1,
			},
			3,
		);

		expect(activity?.produced.shown).toBe("1 tribunal");
		expect(activity?.idle).toEqual([]);
		expect(activity?.skipped).toEqual([]);
	});

	// A failure is worth saying even beside output: historian can surface
	// results from one query and fail to embed another.
	it("reports failures per plugin whatever else the plugin did", () => {
		const activity = pluginActivity(
			{
				"historian.retrieval.surfaced": 1,
				"historian.embedder.failed": 2,
				"governor.ledger.write_failed": 1,
			},
			3,
		);

		expect(activity?.failed).toEqual([
			{ plugin: "historian", count: 2 },
			{ plugin: "governor", count: 1 },
		]);
		expect(activity?.produced.shown).toBe("1 historian");
	});

	// Sessions, prompts, tool calls and recalled memories are the harness, not
	// a plugin - they are why the old line led with "19 memory".
	it("leaves out observed events entirely", () => {
		const activity = pluginActivity(
			{
				"memory.recalled": 19,
				"session.start": 1,
				"tool.file.read": 40,
				"lineage.change.recorded": 1,
			},
			3,
		);

		expect(activity?.produced.shown).toBe("1 lineage");
		expect(activity?.idle).toEqual([]);
		expect(activity?.unclassified).toEqual([]);
	});

	// A plugin newer than the schema the web app was built with. Saying it
	// ran without guessing what it did is the honest version.
	it("names a plugin whose types the schema does not know as unclassified", () => {
		const activity = pluginActivity({ "cartwright.plan.drafted": 2 }, 3);

		expect(activity?.unclassified).toEqual(["cartwright"]);
		expect(activity?.idle).toEqual([]);
	});

	it("keeps an unknown type from hiding a plugin it cannot place", () => {
		const activity = pluginActivity(
			{ "curator.finding.something_new": 1, "curator.scan.complete": 1 },
			3,
		);

		expect(activity?.idle).toEqual(["curator"]);
		expect(activity?.unclassified).toEqual([]);
	});

	it("caps the produced line and keeps the tail for its title", () => {
		const activity = pluginActivity(
			{
				"historian.retrieval.surfaced": 4,
				"bursar.session.recorded": 3,
				"lineage.change.recorded": 2,
				"onlooker.artifact.ready": 1,
			},
			2,
		);

		expect(activity?.produced).toEqual({
			shown: "4 historian · 3 bursar",
			hidden: "2 lineage · 1 onlooker",
			hiddenCount: 2,
		});
	});

	it("lists names alphabetically so two identical sessions read alike", () => {
		const activity = pluginActivity(
			{
				"librarian.scan.complete": 1,
				"curator.scan.complete": 1,
				"inspector.run.completed": 1,
			},
			3,
		);

		expect(activity?.idle).toEqual(["curator", "inspector", "librarian"]);
	});

	// "__proto__.x" splits to a plugin named __proto__, and a tally kept on a
	// plain object would read Object.prototype for it.
	it("survives a type whose plugin segment is an inherited key", () => {
		expect(
			pluginActivity({ "__proto__.thing": 1, "constructor.x": 1 }, 3)
				?.unclassified,
		).toEqual(["__proto__", "constructor"]);
	});
});
