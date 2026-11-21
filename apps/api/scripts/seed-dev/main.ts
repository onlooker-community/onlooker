/**
 * `pnpm seed:dev` (ONL-300): fills the local stack so every signed-in view of
 * the web app has data. Start `pnpm dev` first; this talks to the running API
 * and writes to its local database, and nowhere else (see local.ts).
 *
 * The only file in the seed that touches Node, so no test imports it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_API, wranglerArgs } from "./local";
import { runSeed } from "./seed";

const WEB = "http://localhost:5173";

async function apiAnswers(): Promise<boolean> {
	try {
		return (await fetch(`${LOCAL_API}/`)).ok;
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	if (!(await apiAnswers())) {
		process.stderr.write(
			`seed:dev: the local API isn't answering at ${LOCAL_API}. Start it with \`pnpm dev\` first.\n`,
		);
		process.exit(2);
	}

	const dir = mkdtempSync(join(tmpdir(), "onlooker-seed-"));
	try {
		const result = await runSeed({
			now: new Date(),
			exec: async (statements) => {
				const file = join(dir, "seed.sql");
				writeFileSync(file, `${statements.join("\n")}\n`);
				execFileSync("pnpm", wranglerArgs(file), {
					stdio: ["ignore", "ignore", "inherit"],
				});
			},
			request: (path, init) =>
				fetch(`${LOCAL_API}${path}`, {
					method: init.method,
					headers: {
						"Content-Type": "application/json",
						...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
					},
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				}),
		});

		process.stdout.write(
			[
				"seed:dev: done.",
				`  Log in at ${WEB}/login as ${result.email} / ${result.password}`,
				"  (ada@onlooker.test and sam@onlooker.test use the same password.)",
				`  Pending invite, to open as sam: ${WEB}${result.invitePath}`,
				"  Then open Home, Lessons, Activity, Sessions, Projects, Machines and Orgs.",
				"",
			].join("\n"),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
});
