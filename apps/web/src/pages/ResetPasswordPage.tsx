import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { resetPassword, verifyResetToken } from "../api/accountApi";
import {
	AuthCard,
	FormLink,
	FormMessage,
	PasswordStrengthMeter,
	SubmitButton,
	TextField,
} from "../components/form";
import {
	scorePassword,
	validatePassword,
	validatePasswordMatch,
} from "../lib/validation";

type TokenState =
	| { status: "checking" }
	| { status: "valid"; email?: string }
	| { status: "invalid" };

export default function ResetPasswordPage() {
	const { token } = useParams<{ token: string }>();
	const navigate = useNavigate();

	const [tokenState, setTokenState] = useState<TokenState>({
		status: "checking",
	});
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [fieldErrors, setFieldErrors] = useState<{
		password?: string | null;
		confirmPassword?: string | null;
	}>({});
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [done, setDone] = useState(false);

	const strength = useMemo(() => scorePassword(password), [password]);

	useEffect(() => {
		let active = true;
		if (!token) {
			setTokenState({ status: "invalid" });
			return;
		}
		verifyResetToken(token)
			.then((result) => {
				if (!active) return;
				setTokenState(
					result.valid
						? { status: "valid", email: result.email }
						: { status: "invalid" },
				);
			})
			.catch(() => {
				if (active) setTokenState({ status: "invalid" });
			});
		return () => {
			active = false;
		};
	}, [token]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSubmitError(null);

		const errors = {
			password: validatePassword(password),
			confirmPassword: validatePasswordMatch(password, confirmPassword),
		};
		setFieldErrors(errors);
		if (Object.values(errors).some(Boolean)) return;
		if (!token) return;

		setLoading(true);
		try {
			await resetPassword(token, password);
			setDone(true);
		} catch (err) {
			setSubmitError(
				err instanceof Error
					? err.message
					: "Could not reset your password. The link may have expired.",
			);
		} finally {
			setLoading(false);
		}
	};

	if (tokenState.status === "checking") {
		return (
			<AuthCard title="Reset your password">
				<p style={{ color: "#666" }}>Verifying your reset link...</p>
			</AuthCard>
		);
	}

	if (tokenState.status === "invalid") {
		return (
			<AuthCard
				title="Link expired or invalid"
				footer={
					<FormLink to="/forgot-password">Request a new reset link</FormLink>
				}
			>
				<FormMessage kind="error">
					This password reset link is no longer valid. Reset links expire after
					1 hour and can only be used once.
				</FormMessage>
			</AuthCard>
		);
	}

	if (done) {
		return (
			<AuthCard title="Password updated">
				<FormMessage kind="success">
					Your password has been reset. You can now log in with your new
					password.
				</FormMessage>
				<button
					type="button"
					onClick={() => navigate("/login")}
					style={{
						width: "100%",
						padding: "0.75rem",
						background: "var(--plate-teal)",
						color: "var(--plate-ink)",
						border: "none",
						borderRadius: "4px",
						cursor: "pointer",
						fontSize: "1rem",
						marginTop: "1rem",
					}}
				>
					Continue to login
				</button>
			</AuthCard>
		);
	}

	return (
		<AuthCard
			title="Choose a new password"
			subtitle={
				tokenState.email
					? `Resetting the password for ${tokenState.email}.`
					: undefined
			}
			onSubmit={handleSubmit}
			footer={<FormLink to="/login">Back to login</FormLink>}
		>
			{submitError && <FormMessage kind="error">{submitError}</FormMessage>}

			<TextField
				id="password"
				label="New password"
				type="password"
				value={password}
				onChange={setPassword}
				error={fieldErrors.password}
				disabled={loading}
				autoComplete="new-password"
				required
			/>
			<PasswordStrengthMeter strength={strength} password={password} />

			<TextField
				id="confirmPassword"
				label="Confirm new password"
				type="password"
				value={confirmPassword}
				onChange={setConfirmPassword}
				error={fieldErrors.confirmPassword}
				disabled={loading}
				autoComplete="new-password"
				required
			/>

			<SubmitButton loading={loading} loadingLabel="Updating...">
				Update password
			</SubmitButton>
		</AuthCard>
	);
}
