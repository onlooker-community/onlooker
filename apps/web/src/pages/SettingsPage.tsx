import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	type AccountUser,
	changePassword,
	type DeletionPreview,
	deleteAccount,
	getDeletionPreview,
	getProfile,
	resendVerificationEmail,
	type SoleOwnedOrg,
	updateProfile,
} from "../api/accountApi";
import { auth } from "../auth";
import {
	FormMessage,
	PasswordStrengthMeter,
	SubmitButton,
	TextField,
} from "../components/form";
import { Button, Panel } from "../components/ui";
import { describeError, describeRefusal } from "../lib/apiErrors";
import {
	scorePassword,
	validateEmail,
	validatePassword,
	validatePasswordMatch,
} from "../lib/validation";
import { useReveal } from "../reveal";

export default function SettingsPage() {
	const { user, refresh, logout } = auth.useAuth();
	const navigate = useNavigate();
	// The reveal provider lives above the whole route table, so a reveal opened
	// on /machines can still be on screen here. AppShell marks the page behind
	// it inert, but only the delete-account path below can decide to end it.
	const { dismiss } = useReveal();
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
		<div style={{ maxWidth: "640px", display: "grid", gap: "var(--space-4)" }}>
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
					// Same reason as AppShell's Sign out: the reveal survives a
					// session expiry on purpose, so a deliberate exit has to end it
					// by hand. Deleting the account makes the token dead anyway -
					// leaving it on screen would only be misleading.
					dismiss();
					await logout();
					navigate("/");
				}}
			/>
		</div>
	);
}

function EmailVerificationNotice() {
	const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
		"idle",
	);
	const [errorText, setErrorText] = useState("");

	const resend = async () => {
		setState("sending");
		try {
			await resendVerificationEmail();
			setState("sent");
		} catch (err) {
			setErrorText(
				describeRefusal(err, "Could not send the email. Try again."),
			);
			setState("error");
		}
	};

	return (
		<Panel title="Verify your email" icon="Letter" variant="notice">
			<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
				Your email address hasn't been verified yet. Some features stay locked
				until you confirm it.
			</p>
			{state === "sent" ? (
				<FormMessage kind="success">
					Verification email sent. Check your inbox.
				</FormMessage>
			) : (
				<Button
					onClick={resend}
					variant="ghost"
					loading={state === "sending"}
					loadingLabel="Sending..."
				>
					Resend verification email
				</Button>
			)}
			{state === "error" && (
				<div style={{ color: "var(--red)", marginTop: "0.5rem" }}>
					{errorText}
				</div>
			)}
		</Panel>
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
		<Panel title="Update profile" icon="Pencil">
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
		</Panel>
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
		<Panel title="Change password" icon="Locked">
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
		</Panel>
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
	const [refusal, setRefusal] = useState<SoleOwnedOrg[] | null>(null);
	const [loading, setLoading] = useState(false);
	// Four states, because "no counts yet" and "no counts at all" are different
	// things to say. Fetched when deletion is asked for rather than on mount:
	// almost nobody visiting settings is leaving, and a count read at page load
	// describes a moment nobody was deciding anything in.
	const [preview, setPreview] = useState<
		| { kind: "idle" }
		| { kind: "loading" }
		| { kind: "ready"; counts: DeletionPreview }
		| { kind: "unavailable" }
	>({ kind: "idle" });

	const askToDelete = () => {
		setConfirming(true);
		setPreview({ kind: "loading" });
		getDeletionPreview()
			.then((counts) => setPreview({ kind: "ready", counts }))
			.catch(() => setPreview({ kind: "unavailable" }));
	};

	// Deliberately independent of `preview`. Closing your own account must not
	// depend on a disclosure query succeeding, and the irreversible case is
	// already guarded: deleteAccount refuses with sole_owner while an org would
	// be left ownerless, whatever this preview said or failed to say.
	const canDelete = confirmText.trim().toLowerCase() === email.toLowerCase();

	const handleDelete = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!canDelete) return;
		setError(null);
		setRefusal(null);
		setLoading(true);
		try {
			const result = await deleteAccount();
			if (!result.success) {
				// Not an error state: nothing went wrong, the account simply
				// cannot go yet. onDeleted() tears down the session, so reaching
				// it here would sign somebody out of an account that still
				// exists - and out of the orgs they need to go fix.
				setRefusal(result.orgs);
				setLoading(false);
				return;
			}
			await onDeleted();
		} catch (err) {
			setError(describeError(err, "Could not delete account."));
			setLoading(false);
		}
	};

	return (
		<Panel title="Delete account" icon="Trashbin" variant="danger">
			<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
				Deleting your account cannot be undone. Lessons you shared with an org
				stay with that org; everything else goes, and your account can no longer
				be used.
			</p>
			{!confirming ? (
				<Button onClick={askToDelete} variant="ghost-danger">
					Delete my account
				</Button>
			) : (
				<form onSubmit={handleDelete} noValidate>
					{error && <FormMessage kind="error">{error}</FormMessage>}
					{refusal && (
						<FormMessage kind="error">
							{refusal.length > 0 ? (
								<>
									An org needs an owner. Promote somebody else in{" "}
									{/* Named rather than counted: owning several, a count
									    would say this is blocked without saying by what. */}
									{refusal.map((org, i) => (
										<span key={org.id}>
											{i > 0 && (i === refusal.length - 1 ? " and " : ", ")}
											<strong>{org.name}</strong>
										</span>
									))}
									, or delete the org if you are its only member. Then delete
									your account.
								</>
							) : (
								// The list is what makes this actionable, so without it the
								// honest thing is to say where to look rather than to name
								// nothing and sound broken.
								<>
									An org needs an owner. Check the orgs you own: promote
									somebody else, or delete the org if you are its only member.
									Then delete your account.
								</>
							)}
						</FormMessage>
					)}
					{preview.kind === "loading" && (
						<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
							Checking what deletion will remove…
						</p>
					)}
					{preview.kind === "unavailable" && (
						// Two clauses on purpose. The first is honest about the gap;
						// the second stops the gap reading as a refusal, which is the
						// mistake the sole-owner message exists to prevent in the
						// other direction.
						<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
							Couldn't check what deleting will remove. Your account can still
							be deleted.
						</p>
					)}
					{preview.kind === "ready" && (
						<p style={{ marginTop: 0, color: "var(--ink-dim)" }}>
							{preview.counts.publicLessons === 0 &&
							preview.counts.orgsKeeping.length === 0 ? (
								"You have no shared lessons, so nothing published will be lost."
							) : (
								<>
									{preview.counts.publicLessons > 0 && (
										<>
											Deleting this account will destroy{" "}
											<strong>
												{preview.counts.publicLessons} public{" "}
												{preview.counts.publicLessons === 1
													? "lesson"
													: "lessons"}
											</strong>
											. Anyone holding a link loses it.{" "}
										</>
									)}
									{preview.counts.orgsKeeping.length > 0 && (
										<>
											<strong>
												{preview.counts.orgsKeeping.reduce(
													(n, org) => n + org.lessons,
													0,
												)}{" "}
												lessons stay with their org:
											</strong>{" "}
											{preview.counts.orgsKeeping
												.map((org) => `${org.name} (${org.lessons})`)
												.join(", ")}
											.
										</>
									)}
								</>
							)}
						</p>
					)}
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
						{/*
						  Ghost, so it reads as the lesser of the two actions beside
						  the filled SubmitButton it sits next to. Button's padding
						  is shorter than the 0.75rem 1.5rem this carried inline,
						  but the row is a flex container at its default
						  align-items: stretch, so both still resolve to the same
						  height.
						*/}
						<Button
							onClick={() => {
								setConfirming(false);
								setConfirmText("");
								setError(null);
							}}
							variant="ghost"
							disabled={loading}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}
		</Panel>
	);
}
