import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { playbook } from "../commands/playbook";

const FIXTURE = JSON.parse(
	readFileSync(join(__dirname, "fixtures", "lesson.json"), "utf8"),
);

const IDS = [
	"01KZ45MKAM734ZS7JK24D2DK0R",
	"01KZ45MKAM734ZS7JK24D2DK0S",
	"01KZ45MKAM734ZS7JK24D2DK0T",
];

/** An ONLOOKER_DIR whose mirror holds these lessons. */
function mirrored(lessons: unknown[]): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "onlooker-pb-"));
	mkdirSync(join(dir, "mirror"), { recursive: true });
	for (const lesson of lessons) {
		const { id } = lesson as { id: string };
		writeFileSync(
			join(dir, "mirror", `${id}.json`),
			JSON.stringify(lesson, null, 2),
		);
	}
	return { ONLOOKER_DIR: dir };
}

/** A project root with the named packages installed. */
function project(installed: Record<string, string> = {}): string {
	const root = mkdtempSync(join(tmpdir(), "onlooker-proj-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	for (const [name, version] of Object.entries(installed)) {
		const dir = join(root, "node_modules", ...name.split("/"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
	}
	return root;
}

describe("playbook", () => {
	// An empty mirror and "nothing applies here" are different facts.
	// Collapsing them tells someone their pool is irrelevant when it is
	// merely absent.
	it("says the mirror is empty rather than saying nothing applies", async () => {
		const out = await playbook({ env: mirrored([]), cwd: project() });

		expect(out).toMatch(/nothing has been mirrored/i);
		expect(out).not.toMatch(/applies to this project/i);
	});

	it("groups what is about your changes, what applies, and what it cannot tell", async () => {
		const env = mirrored([
			{
				...FIXTURE,
				id: IDS[1],
				applies_to: {
					...FIXTURE.applies_to,
					file_patterns: ["nothing/here.ts"],
				},
			},
			{
				...FIXTURE,
				id: IDS[2],
				applies_to: { ...FIXTURE.applies_to, stack: ["not-installed"] },
			},
		]);

		const out = await playbook({ env, cwd: project({ vite: "5.2.1" }) });

		expect(out).toMatch(/applies to this project \(1\)/i);
		expect(out).toMatch(/cannot tell \(1\)/i);
		expect(out).toContain(IDS[2]);
	});

	// A verdict without its reason is a claim rather than a finding.
	it("says why each lesson landed where it did", async () => {
		const env = mirrored([
			{
				...FIXTURE,
				id: IDS[0],
				applies_to: { ...FIXTURE.applies_to, stack: ["not-installed"] },
			},
		]);

		const out = await playbook({ env, cwd: project() });

		expect(out).toMatch(/not installed here: not-installed/);
	});

	it("excludes a refuted lesson from advice while still showing it", async () => {
		const env = mirrored([{ ...FIXTURE, id: IDS[0], status: "refuted" }]);

		const out = await playbook({ env, cwd: project({ vite: "5.2.1" }) });

		// Never as advice; visible as excluded, because a refuted lesson
		// sitting in your mirror is worth knowing about.
		expect(out).toMatch(/excluded \(1\)/i);
		expect(out).toMatch(/status is refuted/);
		expect(out).not.toMatch(/applies to this project/i);
	});

	it("reports a mirror file the contract refuses rather than skipping it", async () => {
		const env = mirrored([]);
		writeFileSync(
			join(env.ONLOOKER_DIR as string, "mirror", "broken.json"),
			"{ not json",
		);

		const out = await playbook({ env, cwd: project() });

		expect(out).toMatch(/broken\.json/);
		expect(out).toMatch(/refuses/i);
	});

	it("reports a mirrored lesson that does not match the contract", async () => {
		const env = mirrored([]);
		writeFileSync(
			join(env.ONLOOKER_DIR as string, "mirror", "wrong.json"),
			JSON.stringify({ id: "not-a-ulid", claim: "x" }),
		);

		const out = await playbook({ env, cwd: project() });

		expect(out).toMatch(/wrong\.json/);
	});

	it("emits machine-readable output under --json", async () => {
		const env = mirrored([{ ...FIXTURE, id: IDS[0] }]);

		const out = await playbook({
			env,
			cwd: project({ vite: "5.2.1" }),
			json: true,
		});

		const parsed = JSON.parse(out) as {
			applies: Array<{ id: string; reason: string; verdict: string }>;
		};
		expect(parsed.applies[0].id).toBe(IDS[0]);
		expect(parsed.applies[0].verdict).toBe("applies");
		expect(typeof parsed.applies[0].reason).toBe("string");
	});

	it("carries the migration note when it moved a legacy pool directory", async () => {
		const env = mirrored([]);
		const dir = env.ONLOOKER_DIR as string;
		// The migration only moves when the new directory does not exist.
		rmSync(join(dir, "mirror"), { recursive: true, force: true });
		mkdirSync(join(dir, "pool"), { recursive: true });
		writeFileSync(join(dir, "pool", "cursor.json"), JSON.stringify({ seq: 2 }));

		const out = await playbook({ env, cwd: project() });

		expect(out).toMatch(/Moved/);
		expect(out).toMatch(/mirror/);
	});
});
