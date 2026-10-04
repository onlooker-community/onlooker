import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { acceptInvite, verifyInvite } from "../api/orgsApi";
import { auth } from "../auth";
import { AuthCard, FormLink, FormMessage } from "../components/form";
import { Button } from "../components/ui";
import { describeError } from "../lib/apiErrors";

// Accepting an org invitation. THE TOKEN IS NOT THE WHOLE CREDENTIAL - see
// orgs-invite-accept.ts - so this page has three concerns past verifying the
// token: a caller whose address does not match (403, wrong_account), a
// caller with no session at all (401, since POST /api/orgs/invites/accept
// requires auth: "session"), and everyone else.
//
// This route is deliberately NOT wrapped in <Protected> (see App.tsx) - an
// invitee may arrive with no session and needs to see which org invited them
// before signing up. That is also why this page never calls auth.useAuth():
// it would need an <AuthProvider> this route does not guarantee in every
// render path a test can exercise, and the one piece of session control this
// page needs - ending a stale session so someone can sign in as the right
// address - is available call-free through auth.expireSession().

type Verification =
	| { kind: "checking" }
	| { kind: "invalid" }
	| { kind: "valid"; org: { id: string; name: string }; email: string };

type Outcome =
	| { kind: "idle" }
	| { kind: "accepted" }
	| { kind: "wrong_account" }
	| { kind: "error"; message: string };

function errorStatus(error: unknown): number | undefined {
	if (!(error instanceof Error)) return undefined;
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

export default function AcceptInvitePage() {
	const { token } = useParams<{ token: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const [verification, setVerification] = useState<Verification>({
		kind: "checking",
	});
	const [accepting, setAccepting] = useState(false);
	const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

	useEffect(() => {
		let active = true;
		if (!token) {
			setVerification({ kind: "invalid" });
			return;
		}
		verifyInvite(token)
			.then((check) => {
				if (!active) return;
				if (check.valid && check.org && check.email) {
					setVerification({
						kind: "valid",
						org: check.org,
						email: check.email,
					});
				} else {
					// One state for unknown, expired and already-accepted - see
					// InviteCheck's own doc comment. Naming which would be a hint
					// to whoever is guessing.
					setVerification({ kind: "invalid" });
				}
			})
			.catch(() => {
				if (active) setVerification({ kind: "invalid" });
			});
		return () => {
			active = false;
		};
	}, [token]);

	const accept = async () => {
		if (!token || accepting) return;
		setAccepting(true);
		setOutcome({ kind: "idle" });
		try {
			await acceptInvite(token);
			setOutcome({ kind: "accepted" });
		} catch (error) {
			// No session: the route requires auth: "session" and this caller has
			// none. Sending them to sign up is the one useful thing to do with a
			// link that arrived before an account did.
			if (errorStatus(error) === 401) {
				navigate("/signup", { state: { from: location } });
				return;
			}
			// Wrong account: the invitation is valid, it is simply not this
			// session's. Checked by code rather than status alone, since 403 is
			// not unique to this failure elsewhere in the API.
			if (errorCode(error) === "wrong_account") {
				setOutcome({ kind: "wrong_account" });
				return;
			}
			setOutcome({
				kind: "error",
				message: describeError(error, "Could not accept that invitation."),
			});
		} finally {
			setAccepting(false);
		}
	};

	const signOut = () => {
		// Local-only, the same path the API client's own terminal-401 handler
		// uses (see auth.ts) - a no-op without a mounted AuthProvider, and in
		// the real app it clears the session without a second /auth/logout
		// round trip.
		auth.expireSession();
		navigate("/login");
	};

	if (verification.kind === "checking") {
		return (
			<AuthCard title="Checking your invitation">
				<p style={{ color: "var(--ink-dim)" }}>Just a moment...</p>
			</AuthCard>
		);
	}

	if (verification.kind === "invalid") {
		return (
			<AuthCard
				title="Invitation not usable"
				footer={<FormLink to="/login">Back to login</FormLink>}
			>
				<FormMessage kind="error">
					This invitation is no longer valid. It may have expired, already been
					used, or never existed.
				</FormMessage>
			</AuthCard>
		);
	}

	if (outcome.kind === "accepted") {
		return (
			<AuthCard
				title="You're in"
				footer={<FormLink to="/lessons">Go to the pool</FormLink>}
			>
				<FormMessage kind="success">
					You&apos;ve joined the org. Welcome aboard.
				</FormMessage>
			</AuthCard>
		);
	}

	if (outcome.kind === "wrong_account") {
		return (
			<AuthCard title="Wrong account">
				<FormMessage kind="error">
					That invitation was sent to {verification.email}. Sign out and sign
					back in as that address to accept it.
				</FormMessage>
				<Button onClick={signOut}>Sign out</Button>
			</AuthCard>
		);
	}

	return (
		<AuthCard title="You're invited">
			<p style={{ color: "var(--ink-dim)" }}>
				You&apos;ve been invited to join{" "}
				<strong>{verification.org.name}</strong>.
			</p>
			{outcome.kind === "error" ? (
				<FormMessage kind="error">{outcome.message}</FormMessage>
			) : null}
			<Button
				onClick={() => void accept()}
				loading={accepting}
				loadingLabel="Accepting..."
			>
				Accept invitation
			</Button>
		</AuthCard>
	);
}
