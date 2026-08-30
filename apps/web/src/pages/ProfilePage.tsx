import { Button, Panel } from "../components/ui";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";
import type { UserProfile } from "../types/api";

function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", padding: "0.35rem 0" }}>
			<dt style={{ width: "140px", color: "var(--ink-dim)" }}>{label}</dt>
			<dd style={{ margin: 0 }}>{value}</dd>
		</div>
	);
}

// The account overview lives here and only here. Settings used to carry a
// second copy that had already drifted - it said "Member since" where this
// says "Account created", and it never showed last login at all.
export default function ProfilePage() {
	const { data, loading, error, refetch } =
		useAuthenticatedFetch<UserProfile>("/api/users/me");

	return (
		<div style={{ maxWidth: "640px" }}>
			{loading && <p>Loading your profile…</p>}

			{error && !loading && (
				<Panel title="Profile" icon="CatHead" variant="danger">
					<p style={{ marginTop: 0 }}>Could not load your profile: {error}</p>
					<Button onClick={() => refetch()}>Retry</Button>
				</Panel>
			)}

			{data && !loading && (
				<Panel title="Profile" icon="CatHead">
					<dl style={{ margin: 0 }}>
						<Row label="Name" value={data.name} />
						<Row label="Email" value={data.email} />
						<Row label="Account created" value={formatDate(data.createdAt)} />
						<Row label="Last login" value={formatDate(data.lastLoginAt)} />
					</dl>
				</Panel>
			)}
		</div>
	);
}
