import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../auth";
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
	validateEmail,
	validatePassword,
	validatePasswordMatch,
} from "../lib/validation";

type FieldErrors = {
	name?: string | null;
	email?: string | null;
	password?: string | null;
	confirmPassword?: string | null;
};

export default function SignupPage() {
	const { signup, loading } = auth.useAuth();
	const navigate = useNavigate();

	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
	const [submitError, setSubmitError] = useState<string | null>(null);

	const strength = useMemo(() => scorePassword(password), [password]);

	const validate = (): FieldErrors => {
		return {
			name: name.trim() ? null : "Name is required.",
			email: validateEmail(email),
			password: validatePassword(password),
			confirmPassword: validatePasswordMatch(password, confirmPassword),
		};
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSubmitError(null);

		const errors = validate();
		setFieldErrors(errors);
		if (Object.values(errors).some(Boolean)) return;

		try {
			// On success the auth factory stores the token and hydrates the
			// session, so the user is already logged in — go straight to the app.
			await signup(email.trim(), password, name.trim());
			navigate("/dashboard");
		} catch (err) {
			setSubmitError(
				err instanceof Error ? err.message : "Could not create your account.",
			);
		}
	};

	return (
		<AuthCard
			title="Create your account"
			subtitle="Join Onlooker in a few seconds."
			onSubmit={handleSubmit}
			footer={
				<>
					Already have an account? <FormLink to="/login">Log in</FormLink>
				</>
			}
		>
			{submitError && <FormMessage kind="error">{submitError}</FormMessage>}

			<TextField
				id="name"
				label="Name"
				value={name}
				onChange={setName}
				error={fieldErrors.name}
				disabled={loading}
				autoComplete="name"
				required
			/>

			<TextField
				id="email"
				label="Email"
				type="email"
				value={email}
				onChange={setEmail}
				error={fieldErrors.email}
				disabled={loading}
				autoComplete="email"
				required
			/>

			<TextField
				id="password"
				label="Password"
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
				label="Confirm password"
				type="password"
				value={confirmPassword}
				onChange={setConfirmPassword}
				error={fieldErrors.confirmPassword}
				disabled={loading}
				autoComplete="new-password"
				required
			/>

			<SubmitButton loading={loading} loadingLabel="Creating account...">
				Create account
			</SubmitButton>
		</AuthCard>
	);
}
