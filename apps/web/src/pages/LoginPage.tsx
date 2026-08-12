import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { auth } from "../auth";

export default function LoginPage() {
	const { login, error: authError, loading } = auth.useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);

	// RequireAuth stashes the page the user was blocked from in `state.from`;
	// send them back there after login, falling back to the dashboard.
	const returnTo =
		(location.state as { from?: { pathname?: string } } | null)?.from
			?.pathname ?? "/dashboard";

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		try {
			await login(email, password);
			navigate(returnTo, { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Login failed");
		}
	};

	return (
		<form
			onSubmit={handleSubmit}
			style={{
				maxWidth: "400px",
				margin: "4rem auto",
				padding: "2rem",
				background: "var(--panel)",
				border: "2px solid var(--edge)",
				boxShadow: "6px 6px 0 var(--shadow)",
			}}
		>
			<h1
				style={{
					fontFamily: "var(--font-display)",
					color: "var(--ink-hi)",
					fontSize: "24px",
					letterSpacing: "0.5px",
				}}
			>
				Login
			</h1>

			{(error || authError) && (
				<div style={{ color: "var(--red)", marginBottom: "1rem" }}>
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
					style={{
						width: "100%",
						padding: "0.5rem",
						boxSizing: "border-box",
						background: "var(--ground)",
						color: "var(--ink)",
						// The input carries its own --ground fill, distinct from
						// the card's --panel behind it. A border only needs 3:1
						// against one of its two neighbors, and edge clears that
						// against ground (3.04/3.71) - matches form.tsx's
						// TextField, which borders the same way for the same
						// reason.
						border: "2px solid var(--edge)",
						borderRadius: 0,
						fontFamily: "var(--font-body)",
					}}
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
					style={{
						width: "100%",
						padding: "0.5rem",
						boxSizing: "border-box",
						background: "var(--ground)",
						color: "var(--ink)",
						border: "2px solid var(--edge)",
						borderRadius: 0,
						fontFamily: "var(--font-body)",
					}}
				/>
			</div>

			<button
				type="submit"
				disabled={loading}
				style={{
					width: "100%",
					padding: "0.75rem",
					background: loading ? "var(--panel)" : "var(--plate-teal)",
					color: loading ? "var(--ink)" : "var(--plate-ink)",
					// Same reasoning as form.tsx's SubmitButton: the button sits
					// on the card's panel fill, so var(--edge) fails there too.
					// Disabled swaps to ink-dim (3:1+ against panel); enabled
					// swaps to plate-ink, which holds 7-8.3 against either plate
					// in both themes.
					border: loading
						? "2px solid var(--ink-dim)"
						: "2px solid var(--plate-ink)",
					boxShadow: loading ? "none" : "4px 4px 0 var(--shadow)",
					borderRadius: 0,
					cursor: loading ? "not-allowed" : "pointer",
					fontFamily: "var(--font-display)",
					fontSize: "14px",
					letterSpacing: "1px",
					textTransform: "uppercase",
				}}
			>
				{loading ? "Logging in..." : "Login"}
			</button>
		</form>
	);
}
