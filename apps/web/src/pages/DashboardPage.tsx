import { Link, useNavigate } from "react-router-dom";
import { auth } from "../auth";
import SessionExpiryBanner from "../components/SessionExpiryBanner";
import { useAuthenticatedFetch } from "../hooks/useAuthenticatedFetch";
import type { DashboardData } from "../types/api";

export default function DashboardPage() {
	const { user, logout } = auth.useAuth();
	const navigate = useNavigate();
	const {
		data: dashboard,
		loading,
		error,
		refetch,
	} = useAuthenticatedFetch<DashboardData>("/api/dashboard");

	const handleLogout = async () => {
		await logout();
		navigate("/");
	};

	return (
		<div style={{ maxWidth: "720px", margin: "0 auto", padding: "2rem" }}>
			<h1>Dashboard</h1>
			<SessionExpiryBanner />

			{user && <p>Welcome, {user.name || user.email}!</p>}

			<nav style={{ display: "flex", gap: "1rem", margin: "1rem 0" }}>
				<Link to="/profile">Profile</Link>
				<Link to="/settings">Settings</Link>
				{/*
				  Temporary. RequireAuth still lands here, and AppShell's nav
				  is only reachable from a page that mounts it - so without
				  this, minting a token requires knowing the URL. Deleted with
				  this whole page when /lessons becomes the landing route.
				*/}
				<Link to="/machines">Machines</Link>
				<a href="#recent-activity">Activity log</a>
			</nav>

			<section>
				<h2>Overview</h2>
				{loading && <p>Loading your dashboard…</p>}
				{error && !loading && (
					<div style={{ color: "var(--red)" }}>
						<p>Could not load dashboard data: {error}</p>
						<button
							type="button"
							onClick={() => refetch()}
							style={{ padding: "0.5rem 1rem", cursor: "pointer" }}
						>
							Retry
						</button>
					</div>
				)}
				{dashboard && !loading && (
					<ul
						style={{
							display: "flex",
							gap: "2rem",
							listStyle: "none",
							padding: 0,
						}}
					>
						<li>
							<strong>{dashboard.stats.totalSessions}</strong>
							<div>Sessions</div>
						</li>
						<li>
							<strong>{dashboard.stats.activeProjects}</strong>
							<div>Active projects</div>
						</li>
						<li>
							<strong>{dashboard.stats.unreadNotifications}</strong>
							<div>Unread</div>
						</li>
					</ul>
				)}
			</section>

			{dashboard && dashboard.recentActivity.length > 0 && (
				<section id="recent-activity">
					<h2>Recent activity</h2>
					<ul>
						{dashboard.recentActivity.map((item) => (
							<li key={item.id}>
								{item.description} —{" "}
								<time dateTime={item.timestamp}>
									{new Date(item.timestamp).toLocaleString()}
								</time>
							</li>
						))}
					</ul>
				</section>
			)}

			<button
				type="button"
				onClick={handleLogout}
				style={{
					padding: "0.75rem 1.5rem",
					cursor: "pointer",
					marginTop: "1.5rem",
				}}
			>
				Logout
			</button>
		</div>
	);
}
