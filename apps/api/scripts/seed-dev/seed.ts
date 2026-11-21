/**
 * Runs the dev seed (ONL-300) through two injected functions, so the same
 * code runs against the local stack (main.ts: wrangler and fetch) and the
 * Workers test pool (seed.test.ts: D1 and the worker itself).
 *
 * Base rows go in as SQL; sessions, inventories and lessons go through the
 * API's machine routes, so ingest validates them and builds what it builds in
 * production. Any refusal stops the run: the next run starts by deleting what
 * this one wrote, so a partial seed costs nothing.
 */

import * as bcrypt from "bcryptjs";
import {
	invites,
	lessonTimeline,
	machines,
	SEED_PASSPHRASE,
	sessions,
	USERS,
} from "./fixtures";
import { afterSql, baseSql, resetSql } from "./sql";

export interface SeedRequest {
	method: "GET" | "POST" | "PUT";
	token?: string;
	body?: unknown;
}

export interface SeedDeps {
	now: Date;
	exec(statements: string[]): Promise<void>;
	request(path: string, init: SeedRequest): Promise<Response>;
}

export interface SeedResult {
	email: string;
	password: string;
	/** The pending invite's page, to open logged in as sam. */
	invitePath: string;
}

/** The API's bcrypt cost (utils/crypto.ts), so seeded logins cost what real ones do. */
const BCRYPT_COST = 10;

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** The API refuses any token not shaped `onlk_` + 64 hex. */
async function machineToken(machineId: string): Promise<string> {
	return `onlk_${await sha256Hex(`seed-token-${machineId}`)}`;
}

async function send(
	deps: SeedDeps,
	path: string,
	init: SeedRequest,
): Promise<unknown> {
	const response = await deps.request(path, init);
	const text = await response.text();
	if (!response.ok)
		throw new Error(
			`seed: ${init.method} ${path} returned ${response.status}: ${text}`,
		);
	return text ? JSON.parse(text) : null;
}

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
	const { now } = deps;
	const allMachines = machines(now);

	const tokens: Record<string, string> = {};
	const tokenHashes: Record<string, string> = {};
	for (const machine of allMachines) {
		tokens[machine.id] = await machineToken(machine.id);
		tokenHashes[machine.id] = await sha256Hex(tokens[machine.id]);
	}
	const inviteTokens: Record<string, string> = {};
	const inviteHashes: Record<string, string> = {};
	for (const invite of invites(now)) {
		inviteTokens[invite.id] = await sha256Hex(invite.tokenSeed);
		inviteHashes[invite.id] = await sha256Hex(inviteTokens[invite.id]);
	}
	const passwordHash = await bcrypt.hash(SEED_PASSPHRASE, BCRYPT_COST);

	await deps.exec(resetSql());
	await deps.exec(baseSql({ now, passwordHash, tokenHashes, inviteHashes }));

	const byMachine = new Map<string, unknown[]>();
	for (const { machine, body } of sessions(now))
		byMachine.set(machine, [...(byMachine.get(machine) ?? []), body]);
	for (const [machine, batch] of byMachine)
		await send(deps, "/machine/sessions", {
			method: "POST",
			token: tokens[machine],
			body: { schema_version: 1, sessions: batch },
		});

	for (const machine of allMachines)
		if (machine.inventory)
			await send(deps, "/machine/inventory", {
				method: "PUT",
				token: tokens[machine.id],
				body: machine.inventory,
			});

	const timeline = lessonTimeline(now);
	for (const event of timeline) {
		if (event.kind === "push") {
			const reply = (await send(deps, "/lessons", {
				method: "POST",
				token: tokens[event.machine],
				body: { lessons: [event.lesson] },
			})) as { results: { id: string; outcome: string; error?: string }[] };
			const [result] = reply.results;
			// POST /lessons answers 200 even when it refuses a lesson.
			if (result?.outcome !== "created")
				throw new Error(
					`seed: POST /lessons refused ${event.lesson.id}: ${result?.outcome} ${result?.error ?? ""}`,
				);
		} else {
			await send(deps, `/lessons/${event.lessonId}/status`, {
				method: "POST",
				token: tokens[event.machine],
				body:
					event.supersededBy === null
						? { status: event.status }
						: { status: event.status, superseded_by: event.supersededBy },
			});
		}
	}

	await deps.exec(afterSql(now, timeline));

	return {
		email: USERS.dev.email,
		password: SEED_PASSPHRASE,
		invitePath: `/orgs/invites/${inviteTokens["seed-invite-pending"]}`,
	};
}
