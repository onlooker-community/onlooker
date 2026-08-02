import { useNavigate } from "react-router-dom";
import { auth } from "../auth";

export default function DashboardPage() {
	const { user, logout } = auth.useAuth();
	const navigate = useNavigate();

	const handleLogout = async () => {
		await logout();
		navigate("/");
	};

	return (
		<div style={{ padding: "2rem" }}>
			<h1>Dashboard</h1>
			{user && (
				<>
					<p>Welcome, {user.name || user.email}!</p>
					<p>Email: {user.email}</p>
					<p>User ID: {user.id}</p>
					<button
						type="button"
						onClick={handleLogout}
						style={{ padding: "0.75rem 1.5rem", cursor: "pointer" }}
					>
						Logout
					</button>
				</>
			)}
		</div>
	);
}
