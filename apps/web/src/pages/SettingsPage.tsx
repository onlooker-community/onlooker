import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	type AccountUser,
	changePassword,
	deleteAccount,
	getProfile,
	resendVerificationEmail,
	updateProfile,
} from "../api/accountApi";
import { auth } from "../auth";
import {
	FormLink,
	FormMessage,
	PasswordStrengthMeter,
	SubmitButton,
	TextField,
} from "../components/form";
import { describeError } from "../lib/apiErrors";
import {
	scorePassword,
	validateEmail,
	validatePassword,
	validatePasswordMatch,
} from "../lib/validation";

const sectionStyle: React.CSSProperties = {
	border: "1px solid var(--panel)",
	borderRadius: "8px",
	padding: "1.5rem",
	marginBottom: "1.5rem",
};

export default function SettingsPage() {
	const { user, refresh, logout } = auth.useAuth();
	const navigate = useNavigate();
	const [profile, setProfile] = useState<AccountUser | null>(null);

	useEffect(() => {
		let active = true;
		getProfile()
			.then((res) => {
				if (active) setProfile(res.user);
			})
			.catch(() => {
				// Non-fatal: fall back to the auth-context user for display.
			});
		return () => {
			active = false;
		};
	}, []);

	const display = profile ?? (user as AccountUser | null);

	return (
		<div style={{ maxWidth: "640px", margin: "0 auto", padding: "2rem" }}>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "baseline",
				}}
			>
				<h1>Account settings</h1>
				<FormLink to="/lessons">Back to the pool</FormLink>
			</div>

			<ProfileOverview user={display} />

			{display && display.emailVerified === false && (
				<EmailVerificationNotice />
			)}

			<UpdateProfileSection
				user={display}
				onSaved={async () => {
					await refresh();
					const res = await getProfile().catch(() => null);
					if (res) setProfile(res.user);
				}}
			/>

			<ChangePasswordSection />

			<DeleteAccountSection
				email={display?.email ?? ""}
				onDeleted={async () => {
					await logout();
					navigate("/");
				}}
			/>
		</div>
	);
}

function ProfileOverview({ user }: { user: AccountUser | null }) {
	if (!user) return null;
	const created = user.createdAt
		? new Date(user.createdAt).toLocaleDateString(undefined, {
				year: "numeric",
				month: "long",
				day: "numeric",
			})
		: null;

	return (
		<section style={sectionStyle}>
			<h2 style={{ marginTop: 0 }}>Profile</h2>
			<dl style={{ margin: 0 }}>
				<Row label="Name" value={user.name || "—"} />
				<Row label="Email" value={user.email} />
				{created && <Row label="Member since" value={created} />}
			</dl>
		</section>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", padding: "0.35rem 0" }}>
			<dt style={{ width: "140px", color: "var(--ink-dim)" }}>{label}</dt>
			<dd style={{ margin: 0 }}>{value}</dd>
		</div>
	);
}

function EmailVerificationNotice() {
	const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
		"idle",
	);

	const resend = async () => {
		setState("sending");
		try {
			await resendVerificationEmail();
			setState("sent");
		} catch {
			setState("error");
		}
	};

	return (
		<section style={{ ...sectionStyle, borderColor: "var(--gold)" }}>
			<h2 style={{ marginTop: 0 }}>Verify your email</h2>
			<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
				Your email address hasn't been verified yet. Some features stay locked
				until you confirm it.
			</p>
			{state === "sent" ? (
				<FormMessage kind="success">
					Verification email sent. Check your inbox.
				</FormMessage>
			) : (
				<button
					type="button"
					onClick={resend}
					disabled={state === "sending"}
					style={{
						padding: "0.5rem 1rem",
						cursor: state === "sending" ? "not-allowed" : "pointer",
					}}
				>
					{state === "sending" ? "Sending..." : "Resend verification email"}
				</button>
			)}
			{state === "error" && (
				<div style={{ color: "var(--red)", marginTop: "0.5rem" }}>
					Could not send the email. Try again.
				</div>
			)}
		</section>
	);
}

function UpdateProfileSection({
	user,
	onSaved,
}: {
	user: AccountUser | null;
	onSaved: () => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [errors, setErrors] = useState<{
		name?: string | null;
		email?: string | null;
	}>({});
	const [message, setMessage] = useState<{
		kind: "error" | "success";
		text: string;
	} | null>(null);
	const [loading, setLoading] = useState(false);

	// Seed the inputs once the current profile is available.
	useEffect(() => {
		if (user) {
			setName(user.name ?? "");
			setEmail(user.email);
		}
	}, [user]);

	const dirty = user
		? name !== (user.name ?? "") || email !== user.email
		: false;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setMessage(null);

		const nextErrors = {
			name: name.trim() ? null : "Name is required.",
			email: validateEmail(email),
		};
		setErrors(nextErrors);
		if (Object.values(nextErrors).some(Boolean)) return;

		setLoading(true);
		try {
			await updateProfile({ name: name.trim(), email: email.trim() });
			await onSaved();
			setMessage({ kind: "success", text: "Profile updated." });
		} catch (err) {
			setMessage({
				kind: "error",
				text: describeError(err, "Could not update profile."),
			});
		} finally {
			setLoading(false);
		}
	};

	return (
		<section style={sectionStyle}>
			<h2 style={{ marginTop: 0 }}>Update profile</h2>
			<form onSubmit={handleSubmit} noValidate>
				{message && (
					<FormMessage kind={message.kind}>{message.text}</FormMessage>
				)}
				<TextField
					id="profile-name"
					label="Name"
					value={name}
					onChange={setName}
					error={errors.name}
					disabled={loading}
					autoComplete="name"
				/>
				<TextField
					id="profile-email"
					label="Email"
					type="email"
					value={email}
					onChange={setEmail}
					error={errors.email}
					disabled={loading}
					autoComplete="email"
					hint="Changing your email may require re-verification."
				/>
				<SubmitButton
					loading={loading}
					loadingLabel="Saving..."
					disabled={!dirty}
				>
					Save changes
				</SubmitButton>
			</form>
		</section>
	);
}

function ChangePasswordSection() {
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [errors, setErrors] = useState<{
		currentPassword?: string | null;
		newPassword?: string | null;
		confirmPassword?: string | null;
	}>({});
	const [message, setMessage] = useState<{
		kind: "error" | "success";
		text: string;
	} | null>(null);
	const [loading, setLoading] = useState(false);

	const strength = useMemo(() => scorePassword(newPassword), [newPassword]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setMessage(null);

		const nextErrors = {
			currentPassword: currentPassword ? null : "Enter your current password.",
			newPassword: validatePassword(newPassword),
			confirmPassword: validatePasswordMatch(newPassword, confirmPassword),
		};
		setErrors(nextErrors);
		if (Object.values(nextErrors).some(Boolean)) return;

		setLoading(true);
		try {
			await changePassword({ currentPassword, newPassword });
			setMessage({ kind: "success", text: "Password changed." });
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
		} catch (err) {
			setMessage({
				kind: "error",
				text: describeError(err, "Could not change password."),
			});
		} finally {
			setLoading(false);
		}
	};

	return (
		<section style={sectionStyle}>
			<h2 style={{ marginTop: 0 }}>Change password</h2>
			<form onSubmit={handleSubmit} noValidate>
				{message && (
					<FormMessage kind={message.kind}>{message.text}</FormMessage>
				)}
				<TextField
					id="current-password"
					label="Current password"
					type="password"
					value={currentPassword}
					onChange={setCurrentPassword}
					error={errors.currentPassword}
					disabled={loading}
					autoComplete="current-password"
				/>
				<TextField
					id="new-password"
					label="New password"
					type="password"
					value={newPassword}
					onChange={setNewPassword}
					error={errors.newPassword}
					disabled={loading}
					autoComplete="new-password"
				/>
				<PasswordStrengthMeter strength={strength} password={newPassword} />
				<TextField
					id="confirm-new-password"
					label="Confirm new password"
					type="password"
					value={confirmPassword}
					onChange={setConfirmPassword}
					error={errors.confirmPassword}
					disabled={loading}
					autoComplete="new-password"
				/>
				<SubmitButton loading={loading} loadingLabel="Updating...">
					Change password
				</SubmitButton>
			</form>
		</section>
	);
}

function DeleteAccountSection({
	email,
	onDeleted,
}: {
	email: string;
	onDeleted: () => Promise<void>;
}) {
	const [confirming, setConfirming] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const canDelete = confirmText.trim().toLowerCase() === email.toLowerCase();

	const handleDelete = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!canDelete) return;
		setError(null);
		setLoading(true);
		try {
			await deleteAccount();
			await onDeleted();
		} catch (err) {
			setError(describeError(err, "Could not delete account."));
			setLoading(false);
		}
	};

	return (
		<section style={{ ...sectionStyle, borderColor: "var(--red)" }}>
			<h2 style={{ marginTop: 0, color: "var(--red)" }}>Delete account</h2>
			<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
				Permanently delete your account and all associated data. This cannot be
				undone.
			</p>
			{!confirming ? (
				<button
					type="button"
					onClick={() => setConfirming(true)}
					style={{
						padding: "0.5rem 1rem",
						// Ghost, not a plate: this only opens the confirmation, and a
						// filled danger button here would outrank the actual confirm
						// below it. --red sits on the page ground at 7.94/6.48 as
						// text and clears 3:1 as a border, and it matches the section
						// heading, which the white fill had split away from.
						color: "var(--red)",
						border: "2px solid var(--red)",
						borderRadius: 0,
						background: "transparent",
						cursor: "pointer",
						fontFamily: "var(--font-data)",
						fontSize: "var(--text-data-md)",
						letterSpacing: "1px",
						textTransform: "uppercase",
					}}
				>
					Delete my account
				</button>
			) : (
				<form onSubmit={handleDelete} noValidate>
					{error && <FormMessage kind="error">{error}</FormMessage>}
					<TextField
						id="delete-confirm"
						label={`Type your email (${email}) to confirm`}
						value={confirmText}
						onChange={setConfirmText}
						disabled={loading}
					/>
					<div style={{ display: "flex", gap: "0.75rem" }}>
						<SubmitButton
							loading={loading}
							loadingLabel="Deleting..."
							disabled={!canDelete}
							variant="danger"
						>
							Permanently delete
						</SubmitButton>
						<button
							type="button"
							onClick={() => {
								setConfirming(false);
								setConfirmText("");
								setError(null);
							}}
							disabled={loading}
							style={{
								padding: "0.75rem 1.5rem",
								// Ghost neutral, so it reads as the lesser of the two
								// actions beside the filled SubmitButton it sits next
								// to. --ink is 11.27/10.28 on the page ground and
								// --ink-dim clears 3:1 as its border at 8.06/6.56.
								color: "var(--ink)",
								border: "2px solid var(--ink-dim)",
								borderRadius: 0,
								background: "transparent",
								cursor: "pointer",
								fontFamily: "var(--font-data)",
								fontSize: "var(--text-data-md)",
								letterSpacing: "1px",
								textTransform: "uppercase",
							}}
						>
							Cancel
						</button>
					</div>
				</form>
			)}
		</section>
	);
}
