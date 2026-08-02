import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../auth";

export default function LoginPage() {
	const { login, error: authError, loading } = auth.useAuth();
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		try {
			await login(email, password);
			navigate("/dashboard");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Login failed");
		}
	};

	return (
		<form
			onSubmit={handleSubmit}
			style={{ maxWidth: "400px", margin: "0 auto", padding: "2rem" }}
		>
			<h1>Login</h1>

			{(error || authError) && (
				<div style={{ color: "red", marginBottom: "1rem" }}>
					{error || authError}
				</div>
			)}

			<div style={{ marginBottom: "1rem" }}>
				<label htmlFor="email">Email:</label>
				<input
					id="email"
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
					disabled={loading}
					style={{ width: "100%", padding: "0.5rem" }}
				/>
			</div>

			<div style={{ marginBottom: "1rem" }}>
				<label htmlFor="password">Password:</label>
				<input
					id="password"
					type="password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					required
					disabled={loading}
					style={{ width: "100%", padding: "0.5rem" }}
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				style={{
					width: "100%",
					padding: "0.75rem",
					backgroundColor: loading ? "#ccc" : "#007bff",
					color: "white",
					border: "none",
					borderRadius: "4px",
					cursor: loading ? "not-allowed" : "pointer",
				}}
			>
				{loading ? "Logging in..." : "Login"}
			</button>
		</form>
	);
}
