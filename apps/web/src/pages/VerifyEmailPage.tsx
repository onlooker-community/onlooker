import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { resendVerificationEmail, verifyEmail } from "../api/accountApi";
import { auth } from "../auth";
import { AuthCard, FormLink, FormMessage } from "../components/form";
import { describeRefusal } from "../lib/apiErrors";

type State = "verifying" | "success" | "error";

export default function VerifyEmailPage() {
	const { token } = useParams<{ token: string }>();
	const { user, loading, unavailable } = auth.useAuth();
	// Only a session known to be gone is offered a login. One still loading or
	// unreachable gets `/`, which decides once the session answers (ONL-247).
	const unknown = !user && (loading || unavailable !== null);
	const onward = (signedIn: { to: string; label: string }, label: string) =>
		user
			? signedIn
			: unknown
				? { to: "/", label: "Continue to Onlooker" }
				: { to: "/login", label };
	const afterSuccess = onward(
		{ to: "/lessons", label: "Go to the pool" },
		"Go to login",
	);
	const afterFailure = onward(
		{ to: "/settings", label: "Back to settings" },
		"Back to login",
	);
	const [state, setState] = useState<State>("verifying");
	const [resent, setResent] = useState(false);
	const [resendError, setResendError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		if (!token) {
			setState("error");
			return;
		}
		verifyEmail(token)
			.then(() => {
				if (active) setState("success");
			})
			.catch(() => {
				if (active) setState("error");
			});
		return () => {
			active = false;
		};
	}, [token]);

	if (state === "verifying") {
		return (
			<AuthCard title="Verifying your email">
				<p style={{ color: "var(--ink-dim)" }}>Just a moment...</p>
			</AuthCard>
		);
	}

	if (state === "success") {
		return (
			<AuthCard
				title="Email verified"
				footer={<FormLink to={afterSuccess.to}>{afterSuccess.label}</FormLink>}
			>
				<FormMessage kind="success">
					Your email address has been verified. Thanks for confirming.
				</FormMessage>
			</AuthCard>
		);
	}

	return (
		<AuthCard
			title="Verification failed"
			footer={<FormLink to={afterFailure.to}>{afterFailure.label}</FormLink>}
		>
			<FormMessage kind="error">
				This verification link is invalid or has expired.
			</FormMessage>
			{user &&
				(resent ? (
					<FormMessage kind="success">
						A new verification email is on its way.
					</FormMessage>
				) : (
					<>
						{resendError && (
							<FormMessage kind="error">{resendError}</FormMessage>
						)}
						<button
							type="button"
							onClick={() => {
								setResendError(null);
								resendVerificationEmail()
									.then(() => setResent(true))
									.catch((err) => {
										// A 429 says why and when (ONL-222's mail cap);
										// swallowing it left the button doing nothing.
										setResendError(
											describeRefusal(
												err,
												"Could not send the email. Try again.",
											),
										);
									});
							}}
							style={{
								padding: "0.5rem 1rem",
								cursor: "pointer",
							}}
						>
							Resend verification email
						</button>
					</>
				))}
		</AuthCard>
	);
}
