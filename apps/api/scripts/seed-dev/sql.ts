/**
 * The SQL half of the dev seed (ONL-300): the rows no ingest route can write
 * without mail or a login, and the touches that come after the pushes.
 *
 * Statements, one per string, so seed.ts can hand them to D1's batch in tests
 * and to a `wrangler d1 execute --file` in the runner. Every value comes from
 * fixtures.ts or from hashes seed.ts computed, never from input, but text still
 * goes through `q` because names carry apostrophes.
 */

import {
	daysAgo,
	invites,
	LABELS,
	type LessonEvent,
	MEMBERSHIPS,
	machines,
	ORG,
	SEED_DOMAIN,
	USERS,
} from "./fixtures";

/** A SQL string literal. */
function q(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

const nullable = (value: string | null) => (value === null ? "NULL" : q(value));

/**
 * Deleting the accounts cascades to their machines, sessions, lessons, feed,
 * labels and memberships. Orgs hang off no user, so they go by id.
 */
export function resetSql(): string[] {
	return [
		`DELETE FROM users WHERE email LIKE '%@${SEED_DOMAIN}';`,
		"DELETE FROM orgs WHERE id LIKE 'seed-%';",
	];
}

export interface BaseInput {
	now: Date;
	passwordHash: string;
	/** Machine id -> SHA-256 hex of its token. */
	tokenHashes: Record<string, string>;
	/** Invite id -> SHA-256 hex of its token. */
	inviteHashes: Record<string, string>;
}

export function baseSql({
	now,
	passwordHash,
	tokenHashes,
	inviteHashes,
}: BaseInput): string[] {
	const created = daysAgo(now, 120);
	const statements: string[] = [];

	for (const user of Object.values(USERS))
		statements.push(
			`INSERT INTO users (id, email, password_hash, name, email_verified, created_at, updated_at) VALUES (${q(user.id)}, ${q(user.email)}, ${q(passwordHash)}, ${q(user.name)}, ${q(created)}, ${q(created)}, ${q(created)});`,
		);

	statements.push(
		`INSERT INTO orgs (id, name, created_at, updated_at) VALUES (${q(ORG.id)}, ${q(ORG.name)}, ${q(created)}, ${q(created)});`,
	);
	for (const membership of MEMBERSHIPS)
		statements.push(
			`INSERT INTO org_memberships (id, org_id, user_id, role, created_at) VALUES (${q(membership.id)}, ${q(ORG.id)}, ${q(USERS[membership.user].id)}, ${q(membership.role)}, ${q(created)});`,
		);
	for (const invite of invites(now))
		statements.push(
			`INSERT INTO org_invites (id, org_id, email, role, token_hash, expires_at, invited_by, created_at) VALUES (${q(invite.id)}, ${q(ORG.id)}, ${q(invite.email)}, 'member', ${q(inviteHashes[invite.id])}, ${q(invite.expiresAt)}, ${q(USERS.dev.id)}, ${q(daysAgo(now, 3))});`,
		);

	for (const machine of machines(now))
		statements.push(
			`INSERT INTO machine_tokens (id, user_id, name, token_hash, org_id, created_at) VALUES (${q(machine.id)}, ${q(USERS[machine.owner].id)}, ${q(machine.name)}, ${q(tokenHashes[machine.id])}, ${nullable(machine.orgId)}, ${q(daysAgo(now, machine.createdDaysAgo))});`,
		);

	for (const label of LABELS)
		statements.push(
			`INSERT INTO project_labels (user_id, project_key, machine_id, source, label) VALUES (${q(USERS.dev.id)}, ${q(label.projectKey)}, ${q(label.machineId)}, 'user', ${q(label.label)});`,
		);

	return statements;
}

/**
 * After every push. Retiring a machine has to wait, because a revoked token
 * can no longer push; a removed machine is revoked too, as the API's own
 * remove requires. Ingest stamps last_used_at and every feed row with the
 * moment of the push, so both are moved back to the fixture's times.
 */
export function afterSql(now: Date, timeline: LessonEvent[]): string[] {
	const statements: string[] = [];

	for (const machine of machines(now)) {
		statements.push(
			`UPDATE machine_tokens SET last_used_at = ${nullable(machine.lastUsedHoursAgo === null ? null : daysAgo(now, 0, machine.lastUsedHoursAgo))} WHERE id = ${q(machine.id)};`,
		);
		if (machine.retiredDaysAgo === null) continue;
		const retired = q(daysAgo(now, machine.retiredDaysAgo));
		statements.push(
			machine.state === "removed"
				? `UPDATE machine_tokens SET revoked_at = ${retired}, removed_at = ${retired} WHERE id = ${q(machine.id)};`
				: `UPDATE machine_tokens SET revoked_at = ${retired} WHERE id = ${q(machine.id)};`,
		);
	}

	for (const event of timeline)
		statements.push(
			event.kind === "push"
				? `UPDATE lesson_feed SET at = ${q(event.at)} WHERE lesson_id = ${q(event.lesson.id)} AND kind = 'create';`
				: `UPDATE lesson_feed SET at = ${q(event.at)} WHERE lesson_id = ${q(event.lessonId)} AND kind = 'status';`,
		);

	return statements;
}
