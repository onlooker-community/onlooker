import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { auth } from "../auth";
import {
	AuthCard,
	FormLink,
	FormMessage,
	SubmitButton,
	TextField,
} from "../components/form";

export default function LoginPage() {
	const { login, error: authError, loading } = auth.useAuth();
	const navigate = useNavigate();
	const location = useLocation();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<{
		email?: string | null;
		password?: string | null;
	}>({});

	// RequireAuth stashes the page the user was blocked from in `state.from`;
	// send them back there after login, falling back to the pool.
	const returnTo =
		(location.state as { from?: { pathname?: string } } | null)?.from
			?.pathname ?? "/lessons";

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		// AuthCard's form carries noValidate, so `required` no longer holds an
		// empty submit back on its own. Checked here instead - and deliberately
		// only for emptiness. Running the signup validators would turn away
		// accounts whose passwords predate the current strength rules, and
		// rejecting an address the server would have accepted is worse on the
		// way in than on the way up.
		const errors = {
			email: email.trim() ? null : "Enter your email.",
			password: password ? null : "Enter your password.",
		};
		setFieldErrors(errors);
		if (errors.email || errors.password) return;

		try {
			await login(email, password);
			navigate(returnTo, { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Login failed");
		}
	};

	const message = error || authError;

	return (
		<AuthCard
			title="Login"
			onSubmit={handleSubmit}
			footer={
				// The reset link is back. It was pulled while /auth/forgot-password
				// was a 501 stub - the journey worked against the mock and did not
				// exist in production, so advertising it walked people into a wall.
				// apps/api serves the whole flow now.
				<>
					<FormLink to="/forgot-password">Forgot your password?</FormLink>
					<br />
					No account yet? <FormLink to="/signup">Sign up</FormLink>
				</>
			}
		>
			{message && <FormMessage kind="error">{message}</FormMessage>}

			<TextField
				id="email"
				label="Email"
				type="email"
				value={email}
				onChange={setEmail}
				error={fieldErrors.email}
				required
				disabled={loading}
				autoComplete="email"
			/>

			<TextField
				id="password"
				label="Password"
				type="password"
				value={password}
				onChange={setPassword}
				error={fieldErrors.password}
				required
				disabled={loading}
				autoComplete="current-password"
			/>

			<SubmitButton loading={loading} loadingLabel="Logging in...">
				Login
			</SubmitButton>
		</AuthCard>
	);
}
