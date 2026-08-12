import { Link } from "react-router-dom";
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

export default function ProfilePage() {
	const { data, loading, error, refetch } =
		useAuthenticatedFetch<UserProfile>("/api/users/me");

	return (
		<div style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem" }}>
			<h1>Profile</h1>

			{loading && <p>Loading your profile…</p>}

			{error && !loading && (
				<div style={{ color: "var(--red)", marginBottom: "1rem" }}>
					<p>Could not load your profile: {error}</p>
					<button
						type="button"
						onClick={() => refetch()}
						style={{ padding: "0.5rem 1rem", cursor: "pointer" }}
					>
						Retry
					</button>
				</div>
			)}

			{data && !loading && (
				<dl
					style={{
						display: "grid",
						gridTemplateColumns: "auto 1fr",
						gap: "0.5rem 1.5rem",
						margin: "1.5rem 0",
					}}
				>
					<dt style={{ fontWeight: 600 }}>Name</dt>
					<dd style={{ margin: 0 }}>{data.name}</dd>

					<dt style={{ fontWeight: 600 }}>Email</dt>
					<dd style={{ margin: 0 }}>{data.email}</dd>

					<dt style={{ fontWeight: 600 }}>Account created</dt>
					<dd style={{ margin: 0 }}>{formatDate(data.createdAt)}</dd>

					<dt style={{ fontWeight: 600 }}>Last login</dt>
					<dd style={{ margin: 0 }}>{formatDate(data.lastLoginAt)}</dd>
				</dl>
			)}

			<nav style={{ display: "flex", gap: "1rem", marginTop: "1.5rem" }}>
				<Link to="/dashboard">Back to dashboard</Link>
				<Link to="/settings">Settings</Link>
			</nav>
		</div>
	);
}
