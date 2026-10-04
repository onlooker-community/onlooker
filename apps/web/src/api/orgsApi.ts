import { apiClient } from "./client";

// Org management. Mirrors apps/api/src/routes/orgs*.ts field for field.
//
// Every path is under /api/orgs rather than /auth/*: router.ts:355 records that
// a route outside /api/ cannot be mocked by createMockFetch and cannot be
// reached by an api-contract case, which is how the machine-token surface spent
// three PRs outside the drift gate.

export const ORG_ENDPOINTS = {
	orgs: "/api/orgs",
	inviteVerify: "/api/orgs/invites/verify",
	inviteAccept: "/api/orgs/invites/accept",
} as const;

export type OrgRole = "owner" | "member";

export interface Org {
	id: string;
	name: string;
	role: OrgRole;
}

export interface OrgMember {
	user_id: string;
	name: string | null;
	email: string;
	role: OrgRole;
	created_at: string;
}

export interface PendingInvite {
	id: string;
	email: string;
	role: OrgRole;
	expires_at: string;
	created_at: string;
}

/**
 * What `verify` says about an invitation.
 *
 * One `valid: false` covers unknown, expired and already-accepted, because the
 * API deliberately does not distinguish them - naming which is a hint to
 * whoever is guessing. The UI must not invent a distinction either.
 */
export interface InviteCheck {
	valid: boolean;
	org?: { id: string; name: string };
	email?: string;
	role?: OrgRole;
}

export function listOrgs(): Promise<{ orgs: Org[] }> {
	return apiClient.get<{ orgs: Org[] }>(ORG_ENDPOINTS.orgs);
}

export function createOrg(name: string): Promise<{ org: Org }> {
	return apiClient.post<{ org: Org }>(ORG_ENDPOINTS.orgs, { name });
}

export function renameOrg(
	orgId: string,
	name: string,
): Promise<{ org: { id: string; name: string } }> {
	return apiClient.patch<{ org: { id: string; name: string } }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}`,
		{ name },
	);
}

export function listMembers(orgId: string): Promise<{ members: OrgMember[] }> {
	return apiClient.get<{ members: OrgMember[] }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/members`,
	);
}

export function setMemberRole(
	orgId: string,
	userId: string,
	role: OrgRole,
): Promise<{ member: { user_id: string; role: OrgRole } }> {
	return apiClient.patch<{ member: { user_id: string; role: OrgRole } }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
		{ role },
	);
}

/** Also how a member leaves: pass your own user id. */
export function removeMember(
	orgId: string,
	userId: string,
): Promise<{ removed: string }> {
	return apiClient.delete<{ removed: string }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
	);
}

export function listInvites(
	orgId: string,
): Promise<{ invites: PendingInvite[] }> {
	return apiClient.get<{ invites: PendingInvite[] }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/invites`,
	);
}

export function createInvite(
	orgId: string,
	email: string,
	role: OrgRole = "member",
): Promise<{ invite: PendingInvite }> {
	return apiClient.post<{ invite: PendingInvite }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/invites`,
		{ email, role },
	);
}

export function revokeInvite(
	orgId: string,
	inviteId: string,
): Promise<{ revoked: string }> {
	return apiClient.delete<{ revoked: string }>(
		`${ORG_ENDPOINTS.orgs}/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
	);
}

export function verifyInvite(value: string): Promise<InviteCheck> {
	return apiClient.get<InviteCheck>(
		`${ORG_ENDPOINTS.inviteVerify}?token=${encodeURIComponent(value)}`,
	);
}

export function acceptInvite(
	value: string,
): Promise<{ org_id: string; role: OrgRole }> {
	return apiClient.post<{ org_id: string; role: OrgRole }>(
		ORG_ENDPOINTS.inviteAccept,
		{ token: value },
	);
}
