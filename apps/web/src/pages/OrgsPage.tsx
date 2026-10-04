import {
	type CSSProperties,
	type FormEvent,
	useCallback,
	useEffect,
	useState,
} from "react";
import {
	createInvite,
	createOrg,
	listInvites,
	listMembers,
	listOrgs,
	type Org,
	type OrgMember,
	type OrgRole,
	type PendingInvite,
	removeMember,
	revokeInvite,
	setMemberRole,
} from "../api/orgsApi";
import { ConfirmAction } from "../components/ConfirmAction";
import { FormMessage, SubmitButton, TextField } from "../components/form";
import { PALETTE } from "../components/palette";
import { Button, Chip, EmptyState, Loading, Panel } from "../components/ui";
import { describeError } from "../lib/apiErrors";

// Who is in which org, and who may invite, promote or remove them.
//
// Unlike MachinesPage, a failed load and an empty result are not allowed to
// look the same: "you are not in any org" and "we could not find out" are
// different claims, and this page exists for people deciding whether to ask
// an owner for an invite. See the two rules in task-11-brief.md.

const row: CSSProperties = {
	display: "flex",
	gap: "var(--space-3)",
	alignItems: "center",
	padding: "var(--space-3)",
	borderBottom: `2px solid ${PALETTE.border}`,
};

export default function OrgsPage() {
	const [orgs, setOrgs] = useState<Org[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const { orgs: rows } = await listOrgs();
			setOrgs(rows);
		} catch (error) {
			// Mirrors MachinesPage's load: the list is dropped rather than left
			// stale, so the error branch below can never be read as an answer
			// that happens to be empty.
			setOrgs(null);
			setLoadError(describeError(error, "Could not load your orgs."));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const create = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || creating) return;

		setCreating(true);
		setCreateError(null);
		try {
			const { org } = await createOrg(trimmed);
			// Appended directly rather than reloaded: createOrg already returns
			// the canonical row, and a caller who creates their first org would
			// otherwise watch it vanish the instant a slow or failed refetch
			// landed.
			setOrgs((current) => [...(current ?? []), org]);
			setName("");
		} catch (error) {
			setCreateError(describeError(error, "Could not create that org."));
		} finally {
			setCreating(false);
		}
	};

	return (
		<>
			{loadError ? (
				<div style={{ marginBottom: "1.5rem" }}>
					<FormMessage kind="error">{loadError}</FormMessage>
					<Button variant="ghost" onClick={() => void load()}>
						Retry
					</Button>
				</div>
			) : null}

			<Panel title="Create an org">
				<form onSubmit={create}>
					<TextField
						id="org-name"
						label="Org name"
						value={name}
						onChange={setName}
						disabled={creating}
						placeholder="Acme"
						error={createError}
					/>
					<SubmitButton
						loading={creating}
						loadingLabel="Creating..."
						disabled={!name.trim()}
					>
						Create org
					</SubmitButton>
				</form>
			</Panel>

			<div style={{ marginTop: "1.5rem", display: "grid", gap: "1.5rem" }}>
				{loadError ? null : orgs === null ? (
					<Loading label="Loading your orgs…" />
				) : orgs.length === 0 ? (
					<EmptyState title="You are not in any org">
						Create one above, or ask an owner to invite you.
					</EmptyState>
				) : (
					orgs.map((org) => (
						<OrgSection key={org.id} org={org} onChanged={() => void load()} />
					))
				)}
			</div>
		</>
	);
}

/**
 * One org: its members, and - for an owner only - who is invited and not yet
 * joined.
 *
 * Fetches members for every role, because GET .../members requires only
 * "member" server-side. It does NOT fetch invites unless `org.role` is
 * "owner" - GET .../invites requires "owner" and would 404 for anyone else,
 * and even if it did not, a pending-invitation list is itself an owner
 * control: the first of the two rules below is about controls, but reading
 * owner-only data into a plain member's browser is the same mistake with
 * extra steps.
 */
function OrgSection({
	org,
	onChanged,
}: {
	org: Org;
	/** Call after anything that could change the caller's own membership or
	 * role - a self-removal (leaving) or a role change needs the top-level
	 * list refreshed, not just this section. */
	onChanged: () => void;
}) {
	const isOwner = org.role === "owner";
	const [members, setMembers] = useState<OrgMember[] | null>(null);
	const [membersError, setMembersError] = useState<string | null>(null);
	const [invites, setInvites] = useState<PendingInvite[] | null>(null);
	const [invitesError, setInvitesError] = useState<string | null>(null);
	const [leaving, setLeaving] = useState(false);
	const [leaveError, setLeaveError] = useState<string | null>(null);

	const loadMembers = useCallback(async () => {
		setMembersError(null);
		try {
			const { members: rows } = await listMembers(org.id);
			setMembers(rows);
		} catch (error) {
			setMembers(null);
			setMembersError(describeError(error, "Could not load members."));
		}
	}, [org.id]);

	const loadInvites = useCallback(async () => {
		setInvitesError(null);
		try {
			const { invites: rows } = await listInvites(org.id);
			setInvites(rows);
		} catch (error) {
			setInvites(null);
			setInvitesError(
				describeError(error, "Could not load pending invitations."),
			);
		}
	}, [org.id]);

	useEffect(() => {
		void loadMembers();
	}, [loadMembers]);

	useEffect(() => {
		if (!isOwner) return;
		void loadInvites();
	}, [isOwner, loadInvites]);

	// Resolved at the moment of leaving rather than kept in state: this page
	// has no auth context available to it (see AcceptInvitePage for the same
	// constraint), and the id is only ever needed for this one call.
	const leave = async () => {
		setLeaving(true);
		setLeaveError(null);
		try {
			const { getProfile } = await import("../api/accountApi");
			const { user } = await getProfile();
			await removeMember(org.id, user.id);
			onChanged();
		} catch (error) {
			setLeaveError(describeError(error, "Could not leave that org."));
		} finally {
			setLeaving(false);
		}
	};

	return (
		<Panel title={org.name}>
			<div style={{ marginBottom: "0.75rem" }}>
				<Chip>{isOwner ? "Owner" : "Member"}</Chip>
			</div>

			{membersError ? (
				<FormMessage kind="error">{membersError}</FormMessage>
			) : members === null ? (
				<Loading label="Loading members…" />
			) : (
				<MemberList
					members={members}
					orgId={org.id}
					isOwner={isOwner}
					onChanged={() => {
						void loadMembers();
						onChanged();
					}}
				/>
			)}

			{isOwner ? (
				<>
					<InviteForm orgId={org.id} onCreated={() => void loadInvites()} />
					<div style={{ marginTop: "1rem" }}>
						{invitesError ? (
							<FormMessage kind="error">{invitesError}</FormMessage>
						) : invites === null ? (
							<Loading label="Loading pending invitations…" />
						) : (
							<PendingInvitesList
								orgId={org.id}
								invites={invites}
								onChanged={() => void loadInvites()}
							/>
						)}
					</div>
				</>
			) : (
				<div style={{ marginTop: "1rem" }}>
					{leaveError ? (
						<FormMessage kind="error">{leaveError}</FormMessage>
					) : null}
					<ConfirmAction
						trigger="Leave"
						question={`Leave ${org.name}?`}
						confirmLabel="Yes, leave"
						pendingLabel="Leaving..."
						pending={leaving}
						onConfirm={() => void leave()}
					/>
				</div>
			)}
		</Panel>
	);
}

/**
 * The roster. Read-only for a plain member - the first rule in
 * task-11-brief.md: a role control or a remove control here could only ever
 * 404 for them, since both routes require "owner" server-side.
 */
function MemberList({
	members,
	orgId,
	isOwner,
	onChanged,
}: {
	members: OrgMember[];
	orgId: string;
	isOwner: boolean;
	onChanged: () => void;
}) {
	if (members.length === 0) {
		return <p style={{ color: PALETTE.muted }}>No members.</p>;
	}

	return (
		<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
			{members.map((member) => (
				<li key={member.user_id} style={row}>
					<span style={{ minWidth: 0, flex: 1 }}>
						<span style={{ display: "block" }}>
							{member.name ?? member.email}
						</span>
						<span style={{ color: PALETTE.muted, fontSize: "0.85rem" }}>
							{member.email}
						</span>
					</span>
					{isOwner ? (
						<>
							<RoleControl
								orgId={orgId}
								member={member}
								onChanged={onChanged}
							/>
							<RemoveControl
								orgId={orgId}
								member={member}
								onChanged={onChanged}
							/>
						</>
					) : (
						<Chip>{member.role}</Chip>
					)}
				</li>
			))}
		</ul>
	);
}

function RoleControl({
	orgId,
	member,
	onChanged,
}: {
	orgId: string;
	member: OrgMember;
	onChanged: () => void;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const label = member.name ?? member.email;

	const change = async (role: OrgRole) => {
		if (role === member.role || pending) return;
		setPending(true);
		setError(null);
		try {
			await setMemberRole(orgId, member.user_id, role);
			onChanged();
		} catch (err) {
			setError(describeError(err, "Could not change that member's role."));
		} finally {
			setPending(false);
		}
	};

	return (
		<span style={{ flex: "none" }}>
			<select
				aria-label={`Role for ${label}`}
				value={member.role}
				disabled={pending}
				onChange={(event) => void change(event.target.value as OrgRole)}
			>
				<option value="owner">Owner</option>
				<option value="member">Member</option>
			</select>
			{error ? (
				<div role="alert" style={{ color: PALETTE.danger, fontSize: "0.8rem" }}>
					{error}
				</div>
			) : null}
		</span>
	);
}

function RemoveControl({
	orgId,
	member,
	onChanged,
}: {
	orgId: string;
	member: OrgMember;
	onChanged: () => void;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const label = member.name ?? member.email;

	const remove = async () => {
		setPending(true);
		setError(null);
		try {
			await removeMember(orgId, member.user_id);
			onChanged();
		} catch (err) {
			setError(describeError(err, "Could not remove that member."));
		} finally {
			setPending(false);
		}
	};

	return (
		<span style={{ flex: "none" }}>
			<ConfirmAction
				trigger="Remove"
				question={`Remove ${label}?`}
				confirmLabel="Yes, remove"
				pendingLabel="Removing..."
				pending={pending}
				onConfirm={() => void remove()}
			/>
			{error ? (
				<div role="alert" style={{ color: PALETTE.danger, fontSize: "0.8rem" }}>
					{error}
				</div>
			) : null}
		</span>
	);
}

/** Owner-only: an org the caller does not own never mounts this. */
function InviteForm({
	orgId,
	onCreated,
}: {
	orgId: string;
	onCreated: () => void;
}) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<OrgRole>("member");
	const [inviting, setInviting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = email.trim();
		if (!trimmed || inviting) return;

		setInviting(true);
		setError(null);
		try {
			// The response deliberately omits created_at - see orgsApi.ts - so
			// nothing here reads it. The pending list below gets created_at from
			// its own GET, once this invite shows up there.
			await createInvite(orgId, trimmed, role);
			setEmail("");
			onCreated();
		} catch (err) {
			setError(describeError(err, "Could not send that invitation."));
		} finally {
			setInviting(false);
		}
	};

	return (
		<form onSubmit={submit} style={{ marginTop: "1rem" }}>
			<TextField
				id={`invite-email-${orgId}`}
				label="Email to invite"
				type="email"
				value={email}
				onChange={setEmail}
				disabled={inviting}
				placeholder="person@example.com"
				error={error}
			/>
			<div style={{ marginBottom: "1rem" }}>
				<label
					htmlFor={`invite-role-${orgId}`}
					style={{ display: "block", marginBottom: "0.25rem" }}
				>
					Role
				</label>
				<select
					id={`invite-role-${orgId}`}
					value={role}
					disabled={inviting}
					onChange={(event) => setRole(event.target.value as OrgRole)}
				>
					<option value="member">Member</option>
					<option value="owner">Owner</option>
				</select>
			</div>
			<SubmitButton
				loading={inviting}
				loadingLabel="Inviting..."
				disabled={!email.trim()}
			>
				Invite
			</SubmitButton>
		</form>
	);
}

function PendingInvitesList({
	orgId,
	invites,
	onChanged,
}: {
	orgId: string;
	invites: PendingInvite[];
	onChanged: () => void;
}) {
	if (invites.length === 0) {
		return <p style={{ color: PALETTE.muted }}>No pending invitations.</p>;
	}

	return (
		<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
			{invites.map((invite) => (
				<li key={invite.id} style={row}>
					<span style={{ minWidth: 0, flex: 1 }}>
						{invite.email} <Chip>{invite.role}</Chip>
					</span>
					<RevokeInviteControl
						orgId={orgId}
						invite={invite}
						onChanged={onChanged}
					/>
				</li>
			))}
		</ul>
	);
}

function RevokeInviteControl({
	orgId,
	invite,
	onChanged,
}: {
	orgId: string;
	invite: PendingInvite;
	onChanged: () => void;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const revoke = async () => {
		setPending(true);
		setError(null);
		try {
			await revokeInvite(orgId, invite.id);
			onChanged();
		} catch (err) {
			setError(describeError(err, "Could not revoke that invitation."));
		} finally {
			setPending(false);
		}
	};

	return (
		<span style={{ flex: "none" }}>
			<ConfirmAction
				trigger="Revoke"
				question={`Revoke the invitation to ${invite.email}?`}
				confirmLabel="Yes, revoke"
				pendingLabel="Revoking..."
				pending={pending}
				onConfirm={() => void revoke()}
			/>
			{error ? (
				<div role="alert" style={{ color: PALETTE.danger, fontSize: "0.8rem" }}>
					{error}
				</div>
			) : null}
		</span>
	);
}
