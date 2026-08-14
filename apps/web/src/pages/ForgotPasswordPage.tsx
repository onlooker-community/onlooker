import { useState } from "react";
import { forgotPassword } from "../api/accountApi";
import {
	AuthCard,
	FormLink,
	FormMessage,
	SubmitButton,
	TextField,
} from "../components/form";
import { describeError } from "../lib/apiErrors";
import { validateEmail } from "../lib/validation";

export default function ForgotPasswordPage() {
	const [email, setEmail] = useState("");
	const [fieldError, setFieldError] = useState<string | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [submitted, setSubmitted] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSubmitError(null);

		const error = validateEmail(email);
		setFieldError(error);
		if (error) return;

		setLoading(true);
		try {
			await forgotPassword(email.trim());
			// Always show the same confirmation regardless of whether the address
			// is registered — avoids leaking which emails have accounts.
			setSubmitted(true);
		} catch (err) {
			setSubmitError(
				describeError(err, "Could not send the reset email. Try again."),
			);
		} finally {
			setLoading(false);
		}
	};

	if (submitted) {
		return (
			<AuthCard
				title="Check your email"
				footer={<FormLink to="/login">Back to login</FormLink>}
			>
				<FormMessage kind="success">
					If an account exists for <strong>{email.trim()}</strong>, we've sent a
					link to reset your password. The link expires in 1 hour.
				</FormMessage>
				<p style={{ color: "var(--ink-dim)", fontSize: "0.9rem" }}>
					Didn't get it? Check your spam folder, or{" "}
					<button
						type="button"
						onClick={() => setSubmitted(false)}
						style={{
							background: "none",
							border: "none",
							color: "var(--teal)",
							cursor: "pointer",
							padding: 0,
							font: "inherit",
							textDecoration: "underline",
						}}
					>
						try a different email
					</button>
					.
				</p>
			</AuthCard>
		);
	}

	return (
		<AuthCard
			title="Reset your password"
			subtitle="Enter your email and we'll send you a reset link."
			onSubmit={handleSubmit}
			footer={<FormLink to="/login">Back to login</FormLink>}
		>
			{submitError && <FormMessage kind="error">{submitError}</FormMessage>}

			<TextField
				id="email"
				label="Email"
				type="email"
				value={email}
				onChange={setEmail}
				error={fieldError}
				disabled={loading}
				autoComplete="email"
				required
			/>

			<SubmitButton loading={loading} loadingLabel="Sending...">
				Send reset link
			</SubmitButton>
		</AuthCard>
	);
}
